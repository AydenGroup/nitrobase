import { z } from "zod";
import { CRON_JOB_MODES, type CronJobMode } from "#/config/cloud-sync.ts";
import { getConfig } from "#/config/server.ts";
import { asList } from "#/libs/coded.ts";
import { quoteLiteral } from "#/server/services/supabase/sql.ts";
import { AppError, coded } from "#/utils/error.ts";
import type { CloudQuery } from "./cloud-db";
import type { SyncRun } from "./types";

/**
 * pg_cron jobs, copied in both directions as a step of their own (like the
 * Vault rows): the data dump cannot carry them. `pg_dump --schema '*'`
 * (the CLI's dump_data.sh) leaves out extension configuration tables such
 * as `cron.job`, and a plain COPY into them would fail anyway (owner
 * permissions, row security by `username`, clashing `jobid`s). Jobs are
 * re-created through pg_cron's own API instead: `schedule_in_database`
 * (pg_cron ≥ 1.4) upserts by (name, owner); `alter_job` sets `active`,
 * which that upsert leaves as it was. Run history (`job_run_details`) is
 * never copied.
 */

/** One side's pg_cron facts (a single JSON text value). */
export const CRON_FACTS_SQL =
	"select json_build_object('present', to_regclass('cron.job') is not null, 'user', current_user, 'database', current_database(), 'superuser', coalesce((select rolsuper from pg_roles where rolname = current_user), false))::text as v";

/** The jobs the connecting role can see (a single JSON text value). */
export const CRON_JOBS_SQL =
	"select coalesce(json_agg(json_build_object('jobid', jobid, 'name', jobname, 'schedule', schedule, 'command', command, 'database', database, 'username', username, 'active', active) order by jobid), '[]'::json)::text as v from cron.job";

/** Job names (a single JSON text value). */
export const CRON_NAMES_SQL =
	"select coalesce(json_agg(jobname order by jobname) filter (where jobname is not null), '[]'::json)::text as v from cron.job";

const CronFactsSchema = z.object({
	present: z.boolean(),
	user: z.string(),
	database: z.string(),
	superuser: z.boolean(),
});
export type CronFacts = z.infer<typeof CronFactsSchema>;

const CronJobSchema = z.object({
	jobid: z.coerce.number(),
	name: z.string().nullable(),
	schedule: z.string(),
	command: z.string(),
	database: z.string(),
	username: z.string(),
	active: z.boolean(),
});
export type CronJob = z.infer<typeof CronJobSchema>;

const parseCronFacts = (text: string) =>
	CronFactsSchema.parse(JSON.parse(text.trim()));
export const parseCronJobs = (text: string) =>
	z.array(CronJobSchema).parse(JSON.parse(text.trim()));
const parseCronNames = (text: string) =>
	z.array(z.string()).parse(JSON.parse(text.trim() || "[]"));

interface CronPlanItem {
	name: string;
	/** Role the job runs as on the destination. */
	owner: string;
	active: boolean;
	/** The job's owner changed (the destination cannot keep it). */
	reowned: boolean;
	/** One statement: upsert by name, then set `active`. */
	sql: string;
}

/**
 * The statements that re-create `jobs` on the destination (pure). Unnamed
 * jobs get `<unnamedPrefix><jobid>`; a job keeps its owner when the
 * destination role may create jobs for others (a superuser), else it runs
 * as that role; a job of the source's own database lands in the
 * destination's. `paused` creates every job inactive.
 */
export function planCronJobs(
	jobs: CronJob[],
	options: {
		mode: Exclude<CronJobMode, "skip">;
		source: CronFacts;
		target: CronFacts;
		unnamedPrefix: string;
	},
): CronPlanItem[] {
	const taken = new Set<string>();
	return jobs.map((job) => {
		const owner = options.target.superuser ? job.username : options.target.user;
		let name = job.name?.trim() || `${options.unnamedPrefix}${job.jobid}`;
		// Two owners' jobs of one name would overwrite each other once they
		// share the destination role.
		if (taken.has(`${owner}\n${name}`)) name = `${name}-${job.jobid}`;
		taken.add(`${owner}\n${name}`);
		const database =
			job.database === options.source.database
				? options.target.database
				: job.database;
		const active = options.mode === "paused" ? false : job.active;
		// pg_cron refuses any `username` from a non-superuser, even its own
		// name: null runs the job as the connecting role.
		const username = options.target.superuser ? quoteLiteral(owner) : "null";
		const sql = `select cron.alter_job(job_id := cron.schedule_in_database(${[
			name,
			job.schedule,
			job.command,
			database,
		]
			.map(quoteLiteral)
			.join(", ")}, ${username}, ${active}), active := ${active})`;
		return {
			name,
			owner,
			active,
			reowned: owner !== job.username,
			sql,
		};
	});
}

/**
 * Keys a job command may carry (`Authorization: Bearer <jwt>`, Supabase
 * API keys): redacted from the job log while the jobs are copied.
 */
const TOKEN_PATTERNS = [
	/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	/\bsb_secret_[A-Za-z0-9_-]{8,}/g,
	/\bsb_publishable_[A-Za-z0-9_-]{8,}/g,
];

/** Bearer-looking tokens in the jobs' commands (unique). */
export function cronCommandSecrets(jobs: CronJob[]): string[] {
	const found = new Set<string>();
	for (const job of jobs) {
		for (const pattern of TOKEN_PATTERNS) {
			for (const match of job.command.matchAll(pattern)) found.add(match[0]);
		}
	}
	return [...found];
}

/**
 * What a failed statement may show: the SQLSTATE (when known) and the
 * message's own words. psql also prints the statement (`LINE 1: …`) and
 * Postgres quotes parts of it (`at or near "…"`, `: "…"`); a job's command
 * may hold a key, so quoted fragments and tokens are dropped.
 */
export function cronErrorDetail(text: string, sqlstate?: string): string {
	const lines = text.split("\n").map((item) => item.trim());
	const error = lines.find((item) => /(^|: )(ERROR|FATAL):/.test(item));
	// Driver errors (pg) carry the bare message and a SQLSTATE instead.
	const line = error ?? (sqlstate ? (lines[0] ?? "") : "");
	let words = line
		.replace(/^.*?((ERROR|FATAL):)\s*/, "")
		.replace(/\s+at or near\s+("[^"]*"|'[^']*'|\S+)/g, "")
		.replace(/"[^"]*"/g, '"…"')
		.replace(/'[^']*'/g, "'…'");
	for (const pattern of TOKEN_PATTERNS) {
		words = words.replace(pattern, "[redacted]");
	}
	const code = sqlstate && /^[0-9A-Z]{5}$/.test(sqlstate) ? sqlstate : null;
	return [code, words.trim()].filter(Boolean).join(" ").slice(0, 300);
}

/** The SQLSTATE of a driver error (pg), when it has one. */
const sqlstateOf = (error: unknown) => {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
};

/** A database the cron step reads or writes: one text value per query. */
export interface CronSide {
	value(sql: string): Promise<string>;
}

/** The cloud database (one open connection) as a cron side. */
export const cloudCronSide = (query: CloudQuery): CronSide => ({
	value: async (sql) => {
		const [row] = await query<{ v: unknown }>(sql);
		return row?.v == null ? "" : String(row.v);
	},
});

const errorText = (error: unknown) =>
	error instanceof AppError &&
	typeof (error.params as { detail?: unknown }).detail === "string"
		? String((error.params as { detail: string }).detail)
		: error instanceof Error
			? error.message
			: String(error);

/**
 * Copy the source's jobs to the target. Returns the names expected on the
 * target (verified later), or null when nothing was copied: skipped, no
 * pg_cron on either side, or it failed (a warning, never a failed sync).
 */
export async function copyCronJobs(input: {
	run: SyncRun;
	source: CronSide;
	target: CronSide;
	mode: CronJobMode;
	unnamedPrefix: string;
	/** Tokens found in the commands, for the run's redactor. */
	onSecrets?: (values: string[]) => void;
}): Promise<string[] | null> {
	const { run } = input;
	if (input.mode === "skip") {
		run.job.event("cloud_sync.cron_skipped");
		return null;
	}
	const mode = input.mode;
	try {
		const source = parseCronFacts(await input.source.value(CRON_FACTS_SQL));
		if (!source.present) return null;
		const jobs = parseCronJobs(await input.source.value(CRON_JOBS_SQL));
		if (jobs.length === 0) return [];
		input.onSecrets?.(cronCommandSecrets(jobs));
		const target = parseCronFacts(await input.target.value(CRON_FACTS_SQL));
		if (!target.present) {
			await run.warn(
				coded("CLOUD_WARN_CRON_UNAVAILABLE", { count: jobs.length }),
			);
			return null;
		}
		const plan = planCronJobs(jobs, {
			mode,
			source,
			target,
			unnamedPrefix: input.unnamedPrefix,
		});
		const copied: CronPlanItem[] = [];
		for (const item of plan) {
			try {
				await input.target.value(item.sql);
				copied.push(item);
			} catch (error) {
				await run.warn(
					coded("CLOUD_SYNC_CRON_JOB_FAILED", {
						name: item.name,
						detail: cronErrorDetail(errorText(error), sqlstateOf(error)),
					}),
				);
			}
		}
		run.job.event("cloud_sync.cron_copied", {
			copied: copied.length,
			total: plan.length,
		});
		const names = copied.map((item) => item.name);
		if (mode === "paused" && names.length) {
			await run.warn(coded("CLOUD_WARN_CRON_PAUSED", { names: asList(names) }));
		}
		const reowned = copied.filter((item) => item.reowned);
		if (reowned.length) {
			await run.warn(
				coded("CLOUD_WARN_CRON_OWNER", {
					user: target.user,
					names: asList(reowned.map((item) => item.name)),
				}),
			);
		}
		const kept = copied.filter((item) => !item.reowned);
		if (kept.length) {
			// Same role name, not the same rights: Cloud and self-hosted
			// grant their roles differently.
			await run.warn(
				coded("CLOUD_WARN_CRON_PRIVILEGES", {
					names: asList(kept.map((item) => `${item.name} (${item.owner})`)),
				}),
			);
		}
		return names;
	} catch (error) {
		await run.warn(cronFailure(error));
		return null;
	}
}

/** Warn about copied jobs the target does not list (name sets). */
export async function verifyCronJobs(
	run: SyncRun,
	target: CronSide,
	expected: string[] | null,
): Promise<void> {
	if (!expected?.length) return;
	try {
		const present = new Set(parseCronNames(await target.value(CRON_NAMES_SQL)));
		const missing = expected.filter((name) => !present.has(name));
		if (missing.length) {
			await run.warn(
				coded("CLOUD_WARN_CRON_MISSING", { names: asList(missing) }),
			);
		}
	} catch (error) {
		await run.warn(cronFailure(error));
	}
}

/** A failed read of the jobs (the queries hold no job commands). */
const cronFailure = (error: unknown) =>
	coded("CLOUD_SYNC_CRON_FAILED", {
		detail:
			cronErrorDetail(errorText(error), sqlstateOf(error)) ||
			errorText(error).slice(0, 500),
	});

/**
 * The cron choice of a run: an explicit mode, else (`default`, missing)
 * the instance's CLOUD_SYNC_CRON_JOBS.
 */
export function resolveCronMode(
	value: unknown,
	fallback: CronJobMode = getConfig().CLOUD_SYNC_CRON_JOBS,
): CronJobMode {
	return CRON_JOB_MODES.find((mode) => mode === value) ?? fallback;
}
