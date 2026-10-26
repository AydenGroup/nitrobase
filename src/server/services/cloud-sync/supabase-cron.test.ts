import { describe, expect, it, vi } from "vitest";
import {
	CRON_FACTS_SQL,
	CRON_JOBS_SQL,
	CRON_NAMES_SQL,
	type CronFacts,
	type CronJob,
	type CronSide,
	copyCronJobs,
	cronCommandSecrets,
	cronErrorDetail,
	parseCronJobs,
	planCronJobs,
	resolveCronMode,
	verifyCronJobs,
} from "./supabase-cron";
import type { SyncRun } from "./types";

const facts = (patch: Partial<CronFacts> = {}): CronFacts => ({
	present: true,
	user: "postgres",
	database: "postgres",
	superuser: false,
	...patch,
});

const job = (patch: Partial<CronJob> = {}): CronJob => ({
	jobid: 1,
	name: "nightly",
	schedule: "0 3 * * *",
	command: "select 1",
	database: "postgres",
	username: "postgres",
	active: true,
	...patch,
});

const plan = (
	jobs: CronJob[],
	patch: Partial<Parameters<typeof planCronJobs>[1]> = {},
) =>
	planCronJobs(jobs, {
		mode: "paused",
		source: facts(),
		target: facts({ user: "supabase_admin", superuser: true }),
		unnamedPrefix: "imported-job-",
		...patch,
	});

describe("cron job plan", () => {
	it("re-creates jobs paused by default, upserted by name", () => {
		const [item] = plan([job()]);
		expect(item).toMatchObject({
			name: "nightly",
			owner: "postgres",
			active: false,
			reowned: false,
		});
		expect(item?.sql).toBe(
			"select cron.alter_job(job_id := cron.schedule_in_database(E'nightly', E'0 3 * * *', E'select 1', E'postgres', E'postgres', false), active := false)",
		);
	});

	it("keeps each job's state when asked", () => {
		const items = plan([job(), job({ jobid: 2, name: "off", active: false })], {
			mode: "active",
		});
		expect(items.map((item) => item.active)).toEqual([true, false]);
		expect(items[0]?.sql).toContain(", true), active := true)");
	});

	it("quotes commands with quotes, backslashes and newlines", () => {
		const [item] = plan([
			job({
				command:
					"select net.http_post(url := 'https://x.supabase.co/functions/v1/a\\b',\n body := '{}')",
			}),
		]);
		expect(item?.sql).toContain(
			"E'select net.http_post(url := ''https://x.supabase.co/functions/v1/a\\\\b'',\n body := ''{}'')'",
		);
	});

	it("names unnamed jobs and keeps names unique per owner", () => {
		const items = plan(
			[
				job({ jobid: 7, name: null }),
				job({ jobid: 8, name: "  " }),
				job({ jobid: 9, name: "sync", username: "postgres" }),
				job({ jobid: 10, name: "sync", username: "worker" }),
			],
			{ target: facts({ user: "postgres" }) },
		);
		expect(items.map((item) => item.name)).toEqual([
			"imported-job-7",
			"imported-job-8",
			"sync",
			"sync-10",
		]);
		// A non-superuser destination runs every job as itself.
		expect(items.map((item) => item.owner)).toEqual([
			"postgres",
			"postgres",
			"postgres",
			"postgres",
		]);
		expect(items.map((item) => item.reowned)).toEqual([
			false,
			false,
			false,
			true,
		]);
		// pg_cron refuses any username from a non-superuser (smoke-tested).
		expect(items[0]?.sql).toContain("E'postgres', null, false)");
	});

	it("maps the source's own database to the destination's", () => {
		const items = plan(
			[job(), job({ jobid: 2, name: "other", database: "analytics" })],
			{ target: facts({ database: "app", superuser: true }) },
		);
		expect(items[0]?.sql).toContain("E'select 1', E'app', E'postgres'");
		expect(items[1]?.sql).toContain("E'select 1', E'analytics', E'postgres'");
	});

	it("parses the job list and refuses other shapes", () => {
		expect(
			parseCronJobs(
				JSON.stringify([
					{
						jobid: "3",
						name: null,
						schedule: "* * * * *",
						command: "select 1",
						database: "postgres",
						username: "postgres",
						active: true,
					},
				]),
			),
		).toEqual([job({ jobid: 3, name: null, schedule: "* * * * *" })]);
		expect(() => parseCronJobs('[{"jobid": 1}]')).toThrow();
	});

	it("keeps only the error's own words, without quoted fragments", () => {
		expect(
			cronErrorDetail(
				"psql:<stdin>:1: ERROR:  role \"worker\" does not exist\nLINE 1: select cron.alter_job(job_id := cron.schedule_in_database(E'x', E'* * * * *', E'select secret'",
			),
		).toBe('role "…" does not exist');
		expect(
			cronErrorDetail(
				'ERROR:  syntax error at or near "Bearer eyJhbGciOi"\nLINE 1: …',
			),
		).toBe("syntax error");
		expect(
			cronErrorDetail(
				"ERROR:  invalid input syntax for type json: 'x sb_secret_abcdefghij'",
			),
		).toBe("invalid input syntax for type json: '…'");
		expect(
			cronErrorDetail("ERROR:  bad token sb_secret_abcdefghijkl here"),
		).toBe("bad token [redacted] here");
		expect(cronErrorDetail("LINE 1: select E'secret'")).toBe("");
	});

	it("reports the SQLSTATE of a driver error", () => {
		expect(
			cronErrorDetail(
				'must be superuser to create a job for another role "x"',
				"42501",
			),
		).toBe('42501 must be superuser to create a job for another role "…"');
		// No ERROR line and no SQLSTATE: nothing is shown.
		expect(cronErrorDetail("select 'secret'")).toBe("");
	});

	it("finds bearer-looking tokens in the commands", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJlXzEy";
		expect(
			cronCommandSecrets([
				job({
					command: `select net.http_post(headers := '{"Authorization": "Bearer ${jwt}", "apikey": "sb_secret_abcdefghijkl"}')`,
				}),
				job({ command: `select 'sb_publishable_abcdefghijkl', '${jwt}'` }),
				job({ command: "select 1 -- eyJshort" }),
			]),
		).toEqual([jwt, "sb_secret_abcdefghijkl", "sb_publishable_abcdefghijkl"]);
	});

	it("resolves the run's cron choice, else the instance default", () => {
		expect(resolveCronMode("skip", "paused")).toBe("skip");
		expect(resolveCronMode("default", "active")).toBe("active");
		expect(resolveCronMode(undefined, "paused")).toBe("paused");
		expect(resolveCronMode("nonsense")).toBe("paused");
	});
});

/** A side answering each query from a table (statements: recorded). */
const side = (answers: Partial<Record<string, string>>, fail?: RegExp) => {
	const statements: string[] = [];
	const value = vi.fn(async (sql: string) => {
		if (sql in answers) return answers[sql] ?? "";
		statements.push(sql);
		if (fail?.test(sql)) {
			throw new Error(
				"ERROR:  invalid schedule: nope\nLINE 1: select cron.alter_job(... E'Bearer secret-key'",
			);
		}
		return "";
	});
	return { side: { value } satisfies CronSide, value, statements };
};

const fakeRun = () => {
	const warn = vi.fn(async (_info: unknown) => undefined);
	const event = vi.fn();
	return {
		run: { warn, job: { event } } as unknown as SyncRun,
		warn,
		event,
	};
};

const jobsJson = (jobs: CronJob[]) => JSON.stringify(jobs);

describe("cron job copy", () => {
	const sourceAnswers = {
		[CRON_FACTS_SQL]: JSON.stringify(facts()),
		[CRON_JOBS_SQL]: jobsJson([
			job(),
			job({
				jobid: 2,
				name: "bad",
				schedule: "nope",
				command: "Bearer secret-key",
			}),
		]),
	};

	it("copies paused, warns per failed job without its command", async () => {
		const source = side(sourceAnswers);
		const target = side(
			{ [CRON_FACTS_SQL]: JSON.stringify(facts({ superuser: true })) },
			/nope/,
		);
		const { run, warn, event } = fakeRun();
		const secrets: string[] = [];
		const names = await copyCronJobs({
			run,
			source: source.side,
			target: target.side,
			mode: "paused",
			unnamedPrefix: "imported-job-",
			onSecrets: (values) => secrets.push(...values),
		});
		expect(secrets).toEqual([]);
		expect(names).toEqual(["nightly"]);
		expect(target.statements).toHaveLength(2);
		expect(event).toHaveBeenCalledWith("cloud_sync.cron_copied", {
			copied: 1,
			total: 2,
		});
		expect(warn.mock.calls.map(([info]) => info)).toEqual([
			{
				code: "CLOUD_SYNC_CRON_JOB_FAILED",
				params: { name: "bad", detail: "invalid schedule: nope" },
				text: null,
			},
			{
				code: "CLOUD_WARN_CRON_PAUSED",
				params: { names: { $list: ["nightly"] } },
				text: null,
			},
			{
				code: "CLOUD_WARN_CRON_PRIVILEGES",
				params: { names: { $list: ["nightly (postgres)"] } },
				text: null,
			},
		]);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-key");
	});

	it("hands the commands' tokens to the redactor before writing", async () => {
		const token = "sb_secret_abcdefghijkl";
		const source = side({
			[CRON_FACTS_SQL]: JSON.stringify(facts()),
			[CRON_JOBS_SQL]: jobsJson([job({ command: `select '${token}'` })]),
		});
		const target = side({ [CRON_FACTS_SQL]: JSON.stringify(facts()) });
		const order: string[] = [];
		target.value.mockImplementation(async (sql: string) => {
			order.push(sql === CRON_FACTS_SQL ? "facts" : "write");
			return sql === CRON_FACTS_SQL ? JSON.stringify(facts()) : "";
		});
		const { run } = fakeRun();
		await copyCronJobs({
			run,
			source: source.side,
			target: target.side,
			mode: "paused",
			unnamedPrefix: "x-",
			onSecrets: (values) => order.push(`secrets:${values.join(",")}`),
		});
		expect(order).toEqual([`secrets:${token}`, "facts", "write"]);
	});

	it("skips when asked, or without pg_cron on the source", async () => {
		const source = side(sourceAnswers);
		const target = side({});
		const { run, event } = fakeRun();
		expect(
			await copyCronJobs({
				run,
				source: source.side,
				target: target.side,
				mode: "skip",
				unnamedPrefix: "x-",
			}),
		).toBeNull();
		expect(source.value).not.toHaveBeenCalled();
		expect(event).toHaveBeenCalledWith("cloud_sync.cron_skipped");
		const absent = side({
			[CRON_FACTS_SQL]: JSON.stringify(facts({ present: false })),
		});
		expect(
			await copyCronJobs({
				run,
				source: absent.side,
				target: target.side,
				mode: "paused",
				unnamedPrefix: "x-",
			}),
		).toBeNull();
		expect(absent.value).toHaveBeenCalledTimes(1);
		expect(target.value).not.toHaveBeenCalled();
	});

	it("warns when the destination has no pg_cron", async () => {
		const target = side({
			[CRON_FACTS_SQL]: JSON.stringify(facts({ present: false })),
		});
		const { run, warn } = fakeRun();
		expect(
			await copyCronJobs({
				run,
				source: side(sourceAnswers).side,
				target: target.side,
				mode: "active",
				unnamedPrefix: "x-",
			}),
		).toBeNull();
		expect(warn).toHaveBeenCalledWith({
			code: "CLOUD_WARN_CRON_UNAVAILABLE",
			params: { count: 2 },
			text: null,
		});
		expect(target.statements).toEqual([]);
	});

	it("names jobs that now run as the destination role", async () => {
		const source = side({
			[CRON_FACTS_SQL]: JSON.stringify(facts({ user: "supabase_admin" })),
			[CRON_JOBS_SQL]: jobsJson([job({ username: "supabase_admin" })]),
		});
		const { run, warn } = fakeRun();
		await copyCronJobs({
			run,
			source: source.side,
			target: side({ [CRON_FACTS_SQL]: JSON.stringify(facts()) }).side,
			mode: "active",
			unnamedPrefix: "x-",
		});
		expect(warn).toHaveBeenCalledWith({
			code: "CLOUD_WARN_CRON_OWNER",
			params: { user: "postgres", names: { $list: ["nightly"] } },
			text: null,
		});
	});

	it("turns a failed read into a warning", async () => {
		const { run, warn } = fakeRun();
		const broken: CronSide = {
			value: async () => {
				throw new Error("ERROR:  permission denied for table job");
			},
		};
		expect(
			await copyCronJobs({
				run,
				source: broken,
				target: broken,
				mode: "paused",
				unnamedPrefix: "x-",
			}),
		).toBeNull();
		expect(warn).toHaveBeenCalledWith({
			code: "CLOUD_SYNC_CRON_FAILED",
			params: { detail: "permission denied for table job" },
			text: null,
		});
	});
});

describe("cron job verification", () => {
	it("compares job name sets", async () => {
		const { run, warn } = fakeRun();
		const target = side({ [CRON_NAMES_SQL]: '["a","c"]' });
		await verifyCronJobs(run, target.side, ["a", "b"]);
		expect(warn).toHaveBeenCalledWith({
			code: "CLOUD_WARN_CRON_MISSING",
			params: { names: { $list: ["b"] } },
			text: null,
		});
		warn.mockClear();
		await verifyCronJobs(run, target.side, ["a"]);
		await verifyCronJobs(run, target.side, null);
		expect(warn).not.toHaveBeenCalled();
	});
});
