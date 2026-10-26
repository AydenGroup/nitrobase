import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type App,
	client,
	docker,
	EMAIL,
	FILE_BYTES,
	ipOf,
	KEEP,
	NET,
	P,
	PROJECT,
	ROOT,
	seedCloud,
	startApp,
	stopApp,
	USERS,
	VERSION,
	waitHealthy,
} from "./harness";

/**
 * Smoke test of the Appwrite import driver on this machine's Docker:
 * - aw-agent-c-*: an Appwrite app rendered from templates/appwrite, seeded
 *   like a cloud project (console admin, project, users with passwords, a
 *   database with two tables and rows, a bucket with a file, a function
 *   with a deployment, a web platform) — the "cloud";
 * - aw-agent-d-*: a second, fresh app — the "new app" the import writes to.
 *   Its combined worker also joins the proxy network so it reaches the
 *   "cloud" by its container address (Appwrite Cloud is public in real use).
 * The driver's test, preflight and job step run through a SyncTarget on
 * the local Docker (requests to the new app in curl containers on the
 * proxy network, like on a server). Then: counts compared, a migrated user
 * signs in with their password, the file's bytes match. Everything is
 * removed afterwards (AW_SMOKE_KEEP=1 keeps it).
 */

let cloud: App | null = null;
let dest: App | null = null;
let cloudBase = "";
let destBase = "";
let cloudKey = "";
let pulledCurl = false;

beforeAll(async () => {
	mkdirSync(ROOT, { recursive: true });
	if (
		spawnSync("docker", ["network", "inspect", NET]).status !== 0
	) {
		docker(["network", "create", NET]);
	}
	pulledCurl =
		spawnSync("docker", ["image", "inspect", "curlimages/curl:8.16.0"])
			.status !== 0;
	cloud = await startApp(`${P}-c`, "a0a0a0a0-0000-4000-8000-000000000001", {
		workerOnProxy: false,
	});
	dest = await startApp(`${P}-d`, "d0d0d0d0-0000-4000-8000-000000000002", {
		workerOnProxy: true,
		overrides: { CONSOLE_ADMIN_EMAIL: EMAIL },
	});
	cloudBase = `http://${ipOf(`${cloud.folder}-appwrite`)}/v1`;
	destBase = `http://${ipOf(`${dest.folder}-appwrite`)}/v1`;
	await waitHealthy(cloudBase);
	await waitHealthy(destBase);
	const seeded = await seedCloud(cloudBase);
	cloudKey = seeded.secret;
	process.env.CLOUD_SYNC_EXTRA_ALLOWED_HOSTS = new URL(cloudBase).hostname;
});

afterAll(() => {
	if (KEEP) return;
	for (const app of [cloud, dest]) if (app) stopApp(app);
	spawnSync("docker", ["network", "rm", NET]);
	if (pulledCurl) spawnSync("docker", ["image", "rm", "curlimages/curl:8.16.0"]);
	if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

describe("Appwrite import between two self-hosted apps", () => {
	it("tests, previews and migrates a seeded project into a new app", async () => {
		if (!cloud || !dest) throw new Error("apps not started");
		const { getCloudSyncProvider } = await import("#/config/cloud-sync.ts");
		const { appwriteDriver } = await import(
			"#/server/services/cloud-sync/appwrite.ts"
		);
		const { redactor } = await import("#/server/services/backup/rclone.ts");
		const { redactCodedParams } = await import("#/libs/coded.ts");
		const base = getCloudSyncProvider("appwrite");
		if (!base) throw new Error("no provider");
		// The fake cloud speaks http on a private address (test double).
		const provider = {
			...base,
			schema: z.object({
				endpoint: z.string(),
				projectId: z.string(),
				apiKey: z.string(),
			}),
		};
		const config = { endpoint: cloudBase, projectId: PROJECT, apiKey: cloudKey };

		// 1. Connection test.
		const test = await appwriteDriver.test(provider, config);
		console.info("test", JSON.stringify(test));
		expect(test.steps.map((step) => [step.step, step.ok])).toEqual([
			["version", true],
			["key", true],
			["scopes", true],
		]);
		expect(test.info.version).toBe(VERSION);

		// 2. Preflight (release = the template's, not older than the "cloud").
		const parts = ["auth", "databases", "storage", "function_settings", "platforms"];
		const preflight = await appwriteDriver.preflight(provider, config, {
			direction: "import",
			parts,
			target: {
				serverName: "smoke",
				freeDiskBytes: 50 * 1024 ** 3,
				version: VERSION,
				release: VERSION,
			},
		});
		console.info("preflight", JSON.stringify(preflight));
		expect(preflight.blockers).toEqual([]);
		expect(preflight.project.name).toBe("Smoke Project");
		const counts = Object.fromEntries(
			preflight.contents.flatMap((row) =>
				row.counts.map((item) => [item.unit, item.count]),
			),
		);
		expect(counts).toMatchObject({
			users: 2,
			teams: 1,
			databases: 1,
			tables: 2,
			rows: 5,
			buckets: 1,
			files: 1,
			functions: 1,
			platforms: 1,
		});
		const older = await appwriteDriver.preflight(provider, config, {
			direction: "import",
			parts: ["auth"],
			target: { serverName: "smoke", freeDiskBytes: 10, version: "1.7.4" },
		});
		expect(older.blockers.map((item) => item.code)).toEqual([
			"CLOUD_SYNC_RELEASE_OLDER",
		]);

		// 3. The job step on the new app.
		const opened = await appwriteDriver.open(provider, config, "import");
		await opened.prepare(parts);
		const values: Record<string, string> = {
			...dest.values,
			CONSOLE_ADMIN_EMAIL: EMAIL,
		};
		const redact = (text: string) =>
			redactor([cloudKey, ...opened.secrets()])(text);
		const events: { code: string; params: unknown }[] = [];
		const logs: string[] = [];
		const warnings: unknown[] = [];
		const job = {
			deploymentId: "smoke",
			event: (code: string, params?: Record<string, unknown>) =>
				events.push({
					code,
					params: params && redactCodedParams(params as never, redact),
				}),
			log: (output: string) => logs.push(redact(output)),
		};
		const folder = dest.folder;
		const target = {
			executor: null as never,
			workDir: `${ROOT}/work`,
			appName: `${P}-d`,
			pluginConfig: dest.plugin,
			values,
			container: (service: string) => `${folder}-${service}`,
			run: async (
				command: string,
				failure: unknown,
				options: { input?: string | Buffer } = {},
			) => {
				const result = spawnSync("sh", ["-c", command], {
					input: options.input,
					timeout: 600_000,
					maxBuffer: 64 * 1024 * 1024,
				});
				if (result.status !== 0) {
					const detail = redact(
						result.stderr?.toString() || result.stdout?.toString() || "",
					);
					throw typeof failure === "function"
						? failure(detail)
						: new Error(detail);
				}
				return result.stdout.toString();
			},
			compose: async () => "",
			servicesStopped: async () => undefined,
			servicesStarted: async () => undefined,
		};
		// Only the import's email may sign up: the console cannot be claimed
		// by someone else before the job creates the account.
		expect(values._APP_CONSOLE_WHITELIST_EMAILS).toBe(EMAIL);
		const intruder = await client(destBase)(
			"POST",
			"/account",
			{ "X-Appwrite-Project": "console" },
			{
				userId: "unique()",
				email: "intruder@aw-agent.test",
				password: "intruder-pass-123",
				name: "intruder",
			},
		);
		expect(intruder.status, intruder.text).toBe(401);
		expect((intruder.json as { type?: string }).type).toBe(
			"user_email_not_whitelisted",
		);
		const summary: Record<string, unknown> = { warnings: [] };
		try {
			for (const step of opened.steps(parts)) {
				await step.run({
					job: job as never,
					target,
					parts,
					summary: summary as never,
					warn: async (warning) => {
						warnings.push(warning);
					},
				});
			}
		} finally {
			console.info("events", JSON.stringify(events));
		}
		console.info("summary", JSON.stringify(summary));
		if (process.env.AW_SMOKE_REPORT) {
			writeFileSync(
				process.env.AW_SMOKE_REPORT,
				JSON.stringify({ test, preflight, events, summary, warnings }, null, 1),
			);
		}
		console.info("warnings", JSON.stringify(warnings));
		const codes = events.map((event) => event.code);
		expect(codes).toEqual(
			expect.arrayContaining([
				"appwrite_sync.console_account",
				"appwrite_sync.project_created",
				"appwrite_sync.key_created",
				"appwrite_sync.migration_started",
				"appwrite_sync.migrated",
			]),
		);
		expect(codes).not.toContain("appwrite_sync.cleanup_failed");
		const resources = summary.resources as {
			resource: string;
			source: number | null;
			target: number;
		}[];
		const byResource = Object.fromEntries(
			resources.map((row) => [row.resource, row]),
		);
		for (const resource of [
			"user",
			"team",
			"database",
			"table",
			"row",
			"bucket",
			"file",
			"function",
			"platform",
		]) {
			expect(byResource[resource], resource).toMatchObject({
				source: byResource[resource]?.source,
				target: byResource[resource]?.source,
			});
		}
		expect(byResource.row?.target).toBe(5);

		// Secrets never reach the job log.
		const secrets = [
			cloudKey,
			values.CONSOLE_ADMIN_PASSWORD,
			...opened.secrets(),
		].filter((value) => value && value.length >= 4);
		const logged = JSON.stringify({ events, logs, summary });
		for (const secret of secrets) expect(logged).not.toContain(secret);

		// 4. A migrated user signs in with their password; file bytes match.
		const call = client(destBase);
		const signIn = await call(
			"POST",
			"/account/sessions/email",
			{ "X-Appwrite-Project": PROJECT },
			{ email: USERS[0].email, password: USERS[0].password },
		);
		expect(signIn.status, signIn.text).toBe(201);
		const download = await fetch(
			`${destBase}/storage/buckets/media/files/hello/download`,
			{ headers: { "X-Appwrite-Project": PROJECT } },
		);
		expect(download.status).toBe(200);
		expect(Buffer.from(await download.arrayBuffer())).toEqual(FILE_BYTES);
		// The console admin signs in to the new app's console.
		const admin = await call(
			"POST",
			"/account/sessions/email",
			{ "X-Appwrite-Project": "console" },
			{ email: EMAIL, password: values.CONSOLE_ADMIN_PASSWORD },
		);
		expect(admin.status, admin.text).toBe(201);
		expect(
			(summary.notes as { code: string }[]).map((note) => note.code),
		).toEqual(["CLOUD_NOTE_CONSOLE_ADMIN", "CLOUD_NOTE_REVOKE_CLOUD_KEY"]);

		// 5. Nothing of the import is left in the new app: no migration (it
		// stores the cloud key), no temporary key.
		const cookie = (admin.headers.getSetCookie?.() ?? [])
			.map((value) => value.split(";")[0])
			.find((value) => value.startsWith("a_session_console="));
		if (!cookie) throw new Error("no console session");
		const asAdmin = {
			"X-Appwrite-Project": PROJECT,
			"X-Appwrite-Mode": "admin",
			Cookie: cookie,
		};
		const migrations = await call("GET", "/migrations", asAdmin);
		expect(migrations.status, migrations.text).toBe(200);
		expect((migrations.json as { total: number }).total).toBe(0);
		const consoleAuth = { "X-Appwrite-Project": "console", Cookie: cookie };
		const keys = async () =>
			(
				(await call("GET", `/projects/${PROJECT}/keys`, consoleAuth)).json as {
					total: number;
					keys: { $id: string }[];
				}
			).keys.map((key) => key.$id);
		expect(await keys()).toEqual([]);

		// 6. Crash recovery: a key left by a killed job is removed by the
		// driver's recovery hook (ids from the job state, no secrets).
		const orphan = await call("POST", `/projects/${PROJECT}/keys`, consoleAuth, {
			keyId: "unique()",
			name: "orphan",
			scopes: ["migrations.read"],
		});
		expect(orphan.status, orphan.text).toBe(201);
		const orphanId = (orphan.json as { $id: string }).$id;
		expect(await keys()).toEqual([orphanId]);
		await appwriteDriver.recover?.({
			state: { projectId: PROJECT, keyId: orphanId, migrationId: null },
			target,
		});
		expect(await keys()).toEqual([]);
	});
});
