import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type App,
	client,
	docker,
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
	waitHealthy,
} from "./harness";

/**
 * Smoke test of the Appwrite EXPORT on this machine's Docker:
 * - <p>-s-*: an Appwrite app seeded like a used one (console admin from
 *   the app's own variables, project, users with passwords, tables and
 *   rows, a bucket with a file, a function, a platform) — the app;
 * - <p>-k-*: a fresh app playing Appwrite Cloud: an empty project and a
 *   key with the migration scopes (the connection). Its worker joins the
 *   proxy network to read the app by its container address
 *   (CLOUD_SYNC_EXPORT_SKIP_REACHABILITY: no public HTTPS here).
 * The driver signs in to the app's console, creates a temporary read-only
 * key, starts the migration ON the "cloud" and follows it; then: counts
 * compared, a user signs in on the "cloud" with their password, the file's
 * bytes match, nothing of the export is left (migration record, key), a
 * second export is refused (no longer empty), the given-key path and the
 * crash recovery work. Everything is removed afterwards.
 */

const CLOUD_PROJECT = "cloudproj";
const CLOUD_ADMIN_EMAIL = "cloud-owner@aw-agent.test";
const APP_ADMIN_EMAIL = "app-owner@aw-agent.test";
const CONSOLE = { "X-Appwrite-Project": "console" };

let app: App | null = null;
let cloud: App | null = null;
let appBase = "";
let cloudBase = "";
let cloudKey = "";
let pulledCurl = false;

async function signIn(base: string, email: string, password: string) {
	const call = client(base);
	await call("POST", "/account", CONSOLE, {
		userId: "unique()",
		email,
		password,
		name: email,
	});
	const session = await call("POST", "/account/sessions/email", CONSOLE, {
		email,
		password,
	});
	const cookie = (session.headers.getSetCookie?.() ?? [])
		.map((value) => value.split(";")[0])
		.find((value) => value.startsWith("a_session_console="));
	if (!cookie) throw new Error(`no console session: ${session.text}`);
	return cookie;
}

/** The "cloud" project and the connection's key (migrations + reads). */
async function setupCloud(base: string, password: string) {
	const call = client(base);
	const cookie = await signIn(base, CLOUD_ADMIN_EMAIL, password);
	const auth = { ...CONSOLE, Cookie: cookie };
	const teams = await call("GET", "/teams", auth);
	const team =
		(teams.json as { teams?: { $id: string }[] }).teams?.[0] ??
		((await call("POST", "/teams", auth, { teamId: "unique()", name: "Org" }))
			.json as { $id: string });
	const project = await call("POST", "/projects", auth, {
		projectId: CLOUD_PROJECT,
		name: "Cloud Project",
		teamId: team.$id,
	});
	if (project.status >= 300 && project.status !== 409) {
		throw new Error(`project: ${project.status} ${project.text}`);
	}
	const key = await call("POST", `/projects/${CLOUD_PROJECT}/keys`, auth, {
		keyId: "unique()",
		name: "connection",
		scopes: [
			"migrations.read",
			"migrations.write",
			"users.read",
			"teams.read",
			"databases.read",
			"buckets.read",
			"functions.read",
			"platforms.read",
		],
	});
	if (key.status !== 201) throw new Error(`key: ${key.status} ${key.text}`);
	return String((key.json as { secret: string }).secret);
}

beforeAll(async () => {
	mkdirSync(ROOT, { recursive: true });
	if (spawnSync("docker", ["network", "inspect", NET]).status !== 0) {
		docker(["network", "create", NET]);
	}
	pulledCurl =
		spawnSync("docker", ["image", "inspect", "curlimages/curl:8.16.0"])
			.status !== 0;
	app = await startApp(`${P}-s`, "5a5a5a5a-0000-4000-8000-000000000003", {
		workerOnProxy: false,
		overrides: { CONSOLE_ADMIN_EMAIL: APP_ADMIN_EMAIL },
	});
	cloud = await startApp(`${P}-k`, "c1c1c1c1-0000-4000-8000-000000000004", {
		workerOnProxy: true,
		overrides: { CONSOLE_ADMIN_EMAIL: CLOUD_ADMIN_EMAIL },
	});
	appBase = `http://${ipOf(`${app.folder}-appwrite`)}/v1`;
	cloudBase = `http://${ipOf(`${cloud.folder}-appwrite`)}/v1`;
	await waitHealthy(appBase);
	await waitHealthy(cloudBase);
	// The app's console admin is the one its variables name (like an app
	// made by an import): the export signs in with it.
	await seedCloud(appBase, {
		email: APP_ADMIN_EMAIL,
		password: app.values.CONSOLE_ADMIN_PASSWORD,
	});
	cloudKey = await setupCloud(cloudBase, cloud.values.CONSOLE_ADMIN_PASSWORD);
	process.env.CLOUD_SYNC_EXTRA_ALLOWED_HOSTS = new URL(cloudBase).hostname;
});

afterAll(() => {
	if (KEEP) return;
	for (const item of [app, cloud]) if (item) stopApp(item);
	spawnSync("docker", ["network", "rm", NET]);
	if (pulledCurl) spawnSync("docker", ["image", "rm", "curlimages/curl:8.16.0"]);
	if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

describe("Appwrite export into an empty project of another app", () => {
	it("tests, previews and exports through the cloud's migration, then refuses a non-empty project", async () => {
		if (!app || !cloud) throw new Error("apps not started");
		const { getCloudSyncProvider } = await import("#/config/cloud-sync.ts");
		const { appwriteDriver } = await import(
			"#/server/services/cloud-sync/appwrite.ts"
		);
		const { redactor } = await import("#/server/services/backup/rclone.ts");
		const { redactCodedParams } = await import("#/libs/coded.ts");
		const base = getCloudSyncProvider("appwrite");
		if (!base) throw new Error("no provider");
		// The "cloud" speaks http on a private address (test double).
		const provider = {
			...base,
			schema: z.object({
				endpoint: z.string(),
				projectId: z.string(),
				apiKey: z.string(),
			}),
		};
		const config = {
			endpoint: cloudBase,
			projectId: CLOUD_PROJECT,
			apiKey: cloudKey,
		};
		const secrets: string[] = [cloudKey, app.values.CONSOLE_ADMIN_PASSWORD];
		const redact = (text: string) => redactor(secrets)(text);
		const folder = app.folder;
		const values: Record<string, string> = {
			...app.values,
			CONSOLE_ADMIN_EMAIL: APP_ADMIN_EMAIL,
		};
		const target = {
			executor: null as never,
			workDir: `${ROOT}/work`,
			appName: `${P}-s`,
			pluginConfig: app.plugin,
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
		const source = {
			target,
			publicUrl: new URL(appBase).origin,
			inputs: { localProjectId: PROJECT, localApiKey: "" },
		};
		const parts = ["auth", "databases", "storage", "function_settings", "platforms"];

		// 1. Connection test: the key may export (migrations.write).
		const test = await appwriteDriver.test(provider, config);
		console.info("test", JSON.stringify(test));
		expect(test.directions?.map((item) => [item.direction, item.ok])).toEqual([
			["import", true],
			["export", true],
		]);

		// 2. What the modal offers: the app's projects (console sign-in).
		const options = await appwriteDriver.exportOptions?.(source);
		expect(options?.projects?.map((project) => project.id)).toEqual([PROJECT]);
		expect(options?.hidden).toEqual(["localApiKey"]);

		// 3. Preflight: empty cloud, versions, the app's counts.
		const preflight = await appwriteDriver.preflight(provider, config, {
			direction: "export",
			parts,
			target: { serverName: "smoke", freeDiskBytes: null, version: null },
			source,
		});
		console.info("preflight", JSON.stringify(preflight));
		expect(preflight.blockers).toEqual([]);
		expect(preflight.warnings.map((item) => item.code)).toEqual(
			expect.arrayContaining([
				"CLOUD_WARN_EXPORT_REACHABILITY_SKIPPED",
				"CLOUD_WARN_APPWRITE_EXPORT_REDO",
			]),
		);
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
		});

		// 4. The job: emptiness again, then the migration on the "cloud".
		const opened = await appwriteDriver.open(provider, config, "export", source);
		await opened.assertEmpty?.();
		await opened.prepare(parts);
		const events: { code: string; params: unknown }[] = [];
		const logs: string[] = [];
		const warnings: unknown[] = [];
		const checkpoints: unknown[] = [];
		const job = {
			deploymentId: "smoke",
			event: (code: string, params?: Record<string, unknown>) =>
				events.push({
					code,
					params: params && redactCodedParams(params as never, redact),
				}),
			log: (output: string) => logs.push(redact(output)),
		};
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
					checkpoint: async (state) => {
						checkpoints.push(state);
					},
				});
			}
		} finally {
			secrets.push(...opened.secrets());
			console.info("events", JSON.stringify(events));
		}
		console.info("summary", JSON.stringify(summary));
		console.info("warnings", JSON.stringify(warnings));
		const codes = events.map((event) => event.code);
		expect(codes).toEqual(
			expect.arrayContaining([
				"appwrite_sync.export_signed_in",
				"appwrite_sync.export_key_created",
				"appwrite_sync.migration_started",
				"appwrite_sync.migrated",
			]),
		);
		expect(codes).not.toContain("appwrite_sync.export_cleanup_failed");
		// Ids only in the recovery state, cleared at the end.
		expect(checkpoints.at(-1)).toBeNull();
		expect(JSON.stringify(checkpoints)).not.toContain(cloudKey);
		const resources = Object.fromEntries(
			(
				summary.resources as {
					resource: string;
					source: number | null;
					target: number;
				}[]
			).map((row) => [row.resource, row]),
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
		]) {
			expect(resources[resource]?.target, resource).toBe(
				resources[resource]?.source,
			);
		}
		expect(resources.row?.target).toBe(5);
		expect((summary.notes as { code: string }[]).map((note) => note.code)).toEqual(
			["CLOUD_NOTE_EXPORT_APPWRITE_NEXT"],
		);
		// Secrets never reach the job log.
		const logged = JSON.stringify({ events, logs, summary });
		for (const secret of secrets.filter((value) => value.length >= 4)) {
			expect(logged).not.toContain(secret);
		}

		// 5. On the "cloud": a user signs in with their password; file bytes.
		const call = client(cloudBase);
		const signInUser = await call(
			"POST",
			"/account/sessions/email",
			{ "X-Appwrite-Project": CLOUD_PROJECT },
			{ email: USERS[0].email, password: USERS[0].password },
		);
		expect(signInUser.status, signInUser.text).toBe(201);
		const download = await fetch(
			`${cloudBase}/storage/buckets/media/files/hello/download`,
			{ headers: { "X-Appwrite-Project": CLOUD_PROJECT } },
		);
		expect(download.status).toBe(200);
		expect(Buffer.from(await download.arrayBuffer())).toEqual(FILE_BYTES);

		// 6. Nothing of the export is left: the cloud's migration record (it
		// stored the app's key) and the app's temporary key are gone.
		const cloudCookie = await signIn(
			cloudBase,
			CLOUD_ADMIN_EMAIL,
			cloud.values.CONSOLE_ADMIN_PASSWORD,
		);
		const migrations = await call("GET", "/migrations", {
			"X-Appwrite-Project": CLOUD_PROJECT,
			"X-Appwrite-Mode": "admin",
			Cookie: cloudCookie,
		});
		expect(migrations.status, migrations.text).toBe(200);
		expect((migrations.json as { total: number }).total).toBe(0);
		const appCall = client(appBase);
		const appCookie = await signIn(
			appBase,
			APP_ADMIN_EMAIL,
			app.values.CONSOLE_ADMIN_PASSWORD,
		);
		const appConsole = { ...CONSOLE, Cookie: appCookie };
		const keys = async () =>
			(
				(await appCall("GET", `/projects/${PROJECT}/keys`, appConsole)).json as {
					keys: { $id: string; name: string }[];
				}
			).keys
				.filter((key) => key.name !== "cloud-export")
				.map((key) => key.$id);
		expect(await keys()).toEqual([]);

		// 7. The project now holds data: preflight and job refuse.
		const again = await appwriteDriver.preflight(provider, config, {
			direction: "export",
			parts,
			target: { serverName: "smoke", freeDiskBytes: null, version: null },
			source,
		});
		expect(again.blockers.map((item) => item.code)).toContain(
			"CLOUD_EXPORT_NOT_EMPTY",
		);
		const reopened = await appwriteDriver.open(provider, config, "export", source);
		await expect(reopened.assertEmpty?.()).rejects.toMatchObject({
			code: "CLOUD_EXPORT_NOT_EMPTY",
		});

		// 8. Without console credentials the member's key is used instead.
		const given = await appCall("POST", `/projects/${PROJECT}/keys`, appConsole, {
			keyId: "unique()",
			name: "given",
			scopes: ["users.read", "teams.read", "buckets.read", "files.read"],
		});
		expect(given.status, given.text).toBe(201);
		const givenKey = given.json as { $id: string; secret: string };
		const withoutLogin = {
			...source,
			target: { ...target, values: { ...values, CONSOLE_ADMIN_PASSWORD: "" } },
			inputs: { localProjectId: PROJECT, localApiKey: givenKey.secret },
		};
		const givenPreflight = await appwriteDriver.preflight(provider, config, {
			direction: "export",
			parts: ["auth", "storage"],
			target: { serverName: "smoke", freeDiskBytes: null, version: null },
			source: withoutLogin,
		});
		expect(givenPreflight.warnings.map((item) => item.code)).toContain(
			"CLOUD_WARN_APPWRITE_EXPORT_GIVEN_KEY",
		);
		expect(
			givenPreflight.contents.find((row) => row.part === "auth")?.counts[0],
		).toEqual({ unit: "users", count: 2 });
		await expect(
			appwriteDriver.preflight(provider, config, {
				direction: "export",
				parts: ["auth"],
				target: { serverName: "smoke", freeDiskBytes: null, version: null },
				source: { ...withoutLogin, inputs: { localProjectId: PROJECT } },
			}),
		).rejects.toMatchObject({ code: "CLOUD_EXPORT_LOCAL_KEY_REQUIRED" });

		// 9. Crash recovery: a temporary key left by a killed export is
		// removed (ids from the job state, the connection for the cloud).
		await appCall("DELETE", `/projects/${PROJECT}/keys/${givenKey.$id}`, appConsole);
		const orphan = await appCall("POST", `/projects/${PROJECT}/keys`, appConsole, {
			keyId: "unique()",
			name: "orphan",
			scopes: ["users.read"],
		});
		const orphanId = (orphan.json as { $id: string }).$id;
		expect(await keys()).toEqual([orphanId]);
		await appwriteDriver.recover?.({
			state: {
				direction: "export",
				localProjectId: PROJECT,
				localKeyId: orphanId,
				cloudMigrationId: null,
			},
			target,
			connection: { provider, config },
		});
		expect(await keys()).toEqual([]);
	});
});
