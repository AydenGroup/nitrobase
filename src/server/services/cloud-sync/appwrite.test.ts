import { describe, expect, it } from "vitest";
import type { AppwritePluginConfig } from "#/features/appwrite/schema.ts";
import { AppError } from "#/utils/error.ts";
import { endpointRegion, previewContents } from "./appwrite";
import {
	type AppwriteApi,
	appwriteUrl,
	countSource,
	listQuery,
	mapCloudError,
} from "./appwrite-api";
import {
	compareMigration,
	consoleSignInError,
	localRequests,
	migrationError,
	migrationProgress,
	migrationResources,
	parseMigration,
	progressKey,
	sessionCookie,
} from "./appwrite-local";
import {
	analyzeAppwritePreflight,
	compareReleases,
} from "./appwrite-preflight";

const plugin: AppwritePluginConfig = {
	api_service: "appwrite",
	api_port: 80,
	api_path: "/v1",
	console_project: "console",
	console_email: "CONSOLE_ADMIN_EMAIL",
	console_password: "CONSOLE_ADMIN_PASSWORD",
	sync_key_scopes: ["migrations.read", "migrations.write"],
	sync_export_key_scopes: ["users.read", "teams.read", "buckets.read"],
	sync_cloud_key_scopes: ["migrations.read", "migrations.write"],
	sync_resources: {
		auth: ["user", "team", "membership"],
		databases: ["database", "table", "column", "index", "row"],
		storage: ["bucket", "file"],
		function_settings: ["function", "environment-variable"],
		platforms: ["platform"],
	},
};

describe("Appwrite versions", () => {
	it("compares releases numerically", () => {
		expect(compareReleases("1.8.0", "2.3.0")).toBe(-1);
		expect(compareReleases("2.3.0", "2.3.0")).toBe(0);
		expect(compareReleases("2.10.0", "2.9.1")).toBe(1);
		expect(compareReleases("v1.7", "1.7.0")).toBe(0);
		expect(compareReleases("2.3.0-rc.1", "2.3.0")).toBe(-1);
		expect(compareReleases("2.0.0-rc.10", "2.0.0-rc.9")).toBe(1);
		expect(compareReleases("2.0.0-rc.9", "2.0.0-rc.10")).toBe(-1);
		expect(compareReleases("2.0.0-rc.1", "2.0.0-rc.1.1")).toBe(-1);
		expect(compareReleases("2.0.0-1", "2.0.0-alpha")).toBe(-1);
		expect(compareReleases("2.0.0-beta", "2.0.0-alpha")).toBe(1);
		expect(compareReleases("cloud", "2.3.0")).toBeNull();
	});
});

describe("Appwrite preflight analysis", () => {
	const base = {
		projectId: "p1",
		sourceVersion: "1.8.0",
		targetVersion: "2.3.0",
		copyBytes: 1000,
		freeDiskBytes: 1_000_000,
		diskFactor: 2.5,
		functionCount: 2,
		refused: [],
		partial: false,
		wantsFunctions: true,
	};
	const codes = (items: { code: string | null }[]) =>
		items.map((item) => item.code);

	it("allows a release not older than the cloud and lists what changes", () => {
		const result = analyzeAppwritePreflight(base);
		expect(result.blockers).toEqual([]);
		expect(result.requiredDiskBytes).toBe(2500);
		expect(codes(result.warnings)).toEqual([
			"CLOUD_WARN_APPWRITE_ENDPOINT",
			"CLOUD_WARN_APPWRITE_SESSIONS",
			"CLOUD_WARN_APPWRITE_SECRETS",
			"CLOUD_WARN_APPWRITE_FUNCTIONS_DISABLED",
			"CLOUD_WARN_APPWRITE_DEDICATED_KEY",
			"CLOUD_WARN_APPWRITE_FREE_QUOTA",
			"CLOUD_WARN_APPWRITE_NOT_IN_SCOPE",
		]);
	});

	it("refuses an older release, an unknown one and a full disk", () => {
		expect(
			analyzeAppwritePreflight({ ...base, targetVersion: "1.7.4" }).blockers,
		).toEqual([
			expect.objectContaining({
				code: "CLOUD_SYNC_RELEASE_OLDER",
				params: { source: "1.8.0", target: "1.7.4" },
			}),
		]);
		expect(
			codes(
				analyzeAppwritePreflight({
					...base,
					targetVersion: null,
					freeDiskBytes: 10,
				}).blockers,
			),
		).toEqual(["CLOUD_SYNC_RELEASE_UNKNOWN", "CLOUD_SYNC_DISK_LOW"]);
	});

	it("warns about uncounted and partial counts", () => {
		const result = analyzeAppwritePreflight({
			...base,
			refused: ["row", "row", "file"],
			partial: true,
			wantsFunctions: false,
		});
		expect(codes(result.warnings)).toContain("CLOUD_WARN_APPWRITE_UNCOUNTED");
		expect(codes(result.warnings)).toContain(
			"CLOUD_WARN_APPWRITE_COUNTS_PARTIAL",
		);
		expect(codes(result.warnings)).not.toContain(
			"CLOUD_WARN_APPWRITE_FUNCTIONS_DISABLED",
		);
		expect(
			result.warnings.find(
				(item) => item.code === "CLOUD_WARN_APPWRITE_UNCOUNTED",
			)?.params,
		).toEqual({ resources: { $list: ["row", "file"] } });
	});
});

describe("Appwrite Cloud reads", () => {
	it("builds list queries and URLs", () => {
		expect(listQuery("limit", 1)).toBe('{"method":"limit","values":[1]}');
		const url = new URL(
			appwriteUrl("https://fra.cloud.appwrite.io/v1/", "/users", [
				listQuery("limit", 1),
			]),
		);
		expect(url.pathname).toBe("/v1/users");
		expect(url.searchParams.getAll("queries[]")).toEqual([
			'{"method":"limit","values":[1]}',
		]);
		expect(endpointRegion("https://fra.cloud.appwrite.io/v1")).toBe("fra");
		expect(endpointRegion("https://cloud.appwrite.io/v1")).toBe("");
	});

	it("turns a 402 into the read quota error", () => {
		const quota = mapCloudError(
			new AppError("CLOUD_API_FAILED", { status: 402, detail: "limit" }),
		) as AppError;
		expect(quota.code).toBe("CLOUD_APPWRITE_READ_QUOTA");
		const other = new AppError("CLOUD_API_FAILED", { status: 500, detail: "" });
		expect(mapCloudError(other)).toBe(other);
	});

	it("counts resources, capped and refused ones included", async () => {
		const lists: Record<string, { total: number; items: unknown[] }> = {
			"/users": { total: 7, items: [] },
			"/teams": {
				total: 2,
				items: [
					{ $id: "t1", total: 3 },
					{ $id: "t2", total: 1 },
				],
			},
			"/tablesdb": { total: 1, items: [{ $id: "db" }] },
			"/tablesdb/db/tables": {
				total: 2,
				items: [{ $id: "a" }, { $id: "b" }],
			},
			"/tablesdb/db/tables/a/rows": { total: 5000, items: [] },
			"/tablesdb/db/tables/b/rows": { total: 4, items: [] },
			"/storage/buckets": { total: 1, items: [{ $id: "bk" }] },
			"/storage/buckets/bk/files": {
				total: 2,
				items: [
					{ $id: "f1", sizeOriginal: 10 },
					{ $id: "f2", sizeOriginal: 30 },
				],
			},
		};
		const api: AppwriteApi = {
			version: async () => "1.8.0",
			projectName: async () => "Demo",
			list: async (path) => {
				if (path === "/functions") {
					throw new AppError("CLOUD_API_UNAUTHORIZED", { detail: "scope" });
				}
				const list = lists[path];
				if (!list) {
					throw new AppError("CLOUD_API_FAILED", { status: 404, detail: "" });
				}
				return list as { total: number; items: Record<string, unknown>[] };
			},
		};
		const counts = await countSource(
			api,
			migrationResources(plugin, [
				"auth",
				"databases",
				"storage",
				"function_settings",
				"platforms",
			]),
		);
		expect(counts.resources).toMatchObject({
			user: { count: 7, atLeast: false },
			team: { count: 2, atLeast: false },
			membership: { count: 4, atLeast: false },
			database: { count: 1, atLeast: false },
			table: { count: 2, atLeast: true },
			row: { count: 5004, atLeast: true },
			bucket: { count: 1 },
			file: { count: 2 },
		});
		expect(counts.fileBytes).toBe(40);
		expect(counts.refused).toEqual(["function", "environment-variable"]);
		// Platforms are console-only before Appwrite 2.x: not counted.
		expect(counts.resources.platform).toBeUndefined();
		expect(counts.partial).toBe(true);

		const rows = previewContents(plugin, ["auth", "storage"], counts);
		expect(rows).toEqual([
			{
				part: "auth",
				sizeBytes: null,
				counts: [
					{ unit: "users", count: 7 },
					{ unit: "teams", count: 2 },
					{ unit: "memberships", count: 4 },
				],
			},
			{
				part: "storage",
				sizeBytes: 40,
				counts: [
					{ unit: "buckets", count: 1 },
					{ unit: "files", count: 2 },
				],
			},
		]);
	});
});

describe("the new app's Appwrite API", () => {
	it("bootstraps the console with session headers, never secrets in paths", () => {
		const account = localRequests.createAccount(plugin, {
			email: "a@b.co",
			password: "pw-123456789",
			name: "a@b.co",
		});
		expect(account).toMatchObject({
			method: "POST",
			path: "/account",
			headers: {
				"X-Appwrite-Project": "console",
				"Content-Type": "application/json",
			},
			body: { userId: "unique()", email: "a@b.co" },
		});
		const project = localRequests.createProject(plugin, "a_session_console=s", {
			projectId: "p1",
			name: "Demo",
			teamId: "t1",
		});
		expect(project.headers).toEqual({
			"X-Appwrite-Project": "console",
			Cookie: "a_session_console=s",
			"Content-Type": "application/json",
		});
		expect(
			localRequests.createKey(plugin, "c", {
				projectId: "p1",
				name: "k",
				expire: "2026-10-09T00:00:00.000Z",
			}),
		).toMatchObject({
			path: "/projects/p1/keys",
			body: {
				keyId: "unique()",
				scopes: ["migrations.read", "migrations.write"],
			},
		});
		const start = localRequests.startMigration(
			plugin,
			{ project: "p1", secret: "key-secret" },
			{
				endpoint: "https://fra.cloud.appwrite.io/v1",
				projectId: "p1",
				apiKey: "cloud-key",
				resources: ["user"],
			},
		);
		expect(start).toEqual({
			method: "POST",
			path: "/migrations/appwrite",
			headers: {
				"X-Appwrite-Project": "p1",
				"X-Appwrite-Key": "key-secret",
				"Content-Type": "application/json",
			},
			body: {
				resources: ["user"],
				endpoint: "https://fra.cloud.appwrite.io/v1",
				projectId: "p1",
				apiKey: "cloud-key",
				onDuplicate: "fail",
			},
		});
		expect(
			localRequests.retryMigration(
				plugin,
				{ project: "p1", secret: "s" },
				"m1",
			),
		).toMatchObject({ method: "PATCH", path: "/migrations/m1" });
		expect(
			localRequests.deleteKey(plugin, "c", { projectId: "p1", keyId: "k1" })
				.path,
		).toBe("/projects/p1/keys/k1");
	});

	it("removes a migration as the key or the console admin", () => {
		expect(
			localRequests.deleteMigration(
				plugin,
				{ kind: "admin", project: "p1", cookie: "a_session_console=s" },
				"m1",
			),
		).toEqual({
			method: "DELETE",
			path: "/migrations/m1",
			headers: {
				"X-Appwrite-Project": "p1",
				"X-Appwrite-Mode": "admin",
				Cookie: "a_session_console=s",
			},
		});
		expect(
			localRequests.deleteMigration(
				plugin,
				{ kind: "key", project: "p1", secret: "k" },
				"m1",
			).headers,
		).toEqual({ "X-Appwrite-Project": "p1", "X-Appwrite-Key": "k" });
	});

	it("tells a claimed console from other sign-in failures", () => {
		const ok = { status: 201, body: "{}" };
		const body = (type: string) => JSON.stringify({ type });
		expect(consoleSignInError(plugin, "a@b.co", ok, ok)).toBeNull();
		// Someone else signed up first (whitelist or root-only sign-up).
		for (const type of [
			"user_email_not_whitelisted",
			"user_console_count_exceeded",
		]) {
			expect(
				consoleSignInError(
					plugin,
					"a@b.co",
					{ status: 401, body: body(type) },
					{ status: 401, body: body("user_invalid_credentials") },
				)?.code,
			).toBe("APPWRITE_CONSOLE_CLAIMED");
		}
		// The email exists with another password.
		expect(
			consoleSignInError(
				plugin,
				"a@b.co",
				{ status: 409, body: body("user_already_exists") },
				{ status: 401, body: body("user_invalid_credentials") },
			)?.code,
		).toBe("APPWRITE_CONSOLE_CLAIMED");
		// Other failures keep the raw answer.
		const failed = consoleSignInError(plugin, "a@b.co", ok, {
			status: 500,
			body: "boom",
		});
		expect(failed?.code).toBe("APPWRITE_REQUEST_FAILED");
		expect(failed?.params).toMatchObject({ status: 500, detail: "boom" });
	});

	it("notices when a migration makes no progress", () => {
		const read = (success: number) =>
			parseMigration({
				status: "processing",
				stage: "migrating",
				statusCounters: { row: { success, pending: 10 - success } },
			});
		expect(progressKey(read(2))).toBe(progressKey(read(2)));
		expect(progressKey(read(2))).not.toBe(progressKey(read(3)));
	});

	it("maps parts to resources once each", () => {
		expect(migrationResources(plugin, ["storage", "auth", "storage"])).toEqual([
			"bucket",
			"file",
			"user",
			"team",
			"membership",
		]);
		expect(migrationResources(plugin, ["nope"])).toEqual([]);
	});

	it("reads the console session cookie", () => {
		expect(
			sessionCookie(
				[
					["Content-Type", "application/json"],
					["Set-Cookie", "a_session_console_legacy=x; path=/"],
					["set-cookie", "a_session_console=abc123; expires=...; HttpOnly"],
				],
				"console",
			),
		).toBe("a_session_console=abc123");
		expect(sessionCookie([["Set-Cookie", "other=1"]], "console")).toBeNull();
	});

	it("parses a migration, its progress and its errors", () => {
		const status = parseMigration({
			$id: "m1",
			status: "processing",
			stage: "migrating",
			statusCounters: JSON.stringify({
				user: { pending: 1, success: 2, error: 0, skip: 0, processing: 0 },
				row: { pending: 0, success: 3, error: 1, warning: 1 },
			}),
			errors: [
				JSON.stringify({
					code: 0,
					message: "Unable to connect to the migration source",
					resourceName: "row",
				}),
				"plain text",
			],
		});
		expect(status.counters.user).toEqual({
			pending: 1,
			success: 2,
			error: 0,
			skip: 0,
			processing: 0,
		});
		expect(migrationProgress(status)).toEqual({
			done: 7,
			total: 8,
			success: 6,
			errors: 1,
		});
		expect(status.errors).toEqual([
			{ resource: "row", message: "Unable to connect to the migration source" },
			{ resource: "", message: "plain text" },
		]);
		const error = migrationError(status);
		expect(error.code).toBe("APPWRITE_SOURCE_UNREACHABLE");
		expect((error.params as { detail: string }).detail).toContain(
			"row: Unable to connect",
		);
	});

	it("classifies migration errors with the raw message as detail", () => {
		const code = (message: string) =>
			migrationError(parseMigration({ errors: [JSON.stringify({ message })] }))
				.code;
		expect(code("Read limit exceeded (402)")).toBe("APPWRITE_SOURCE_QUOTA");
		expect(code("Missing required scopes.")).toBe(
			"APPWRITE_SOURCE_UNAUTHORIZED",
		);
		expect(code("Something else")).toBe("APPWRITE_MIGRATION_FAILED");
		expect(migrationError(parseMigration({})).code).toBe(
			"APPWRITE_MIGRATION_FAILED",
		);
	});

	it("compares the counters with the cloud's counts", () => {
		const status = parseMigration({
			statusCounters: {
				user: { success: 7 },
				row: { success: 5001, warning: 0, error: 2 },
				file: { success: 1 },
				column: { success: 4 },
			},
		});
		const result = compareMigration(
			{
				user: { count: 7, atLeast: false },
				row: { count: 5000, atLeast: true },
				file: { count: 2, atLeast: false },
				bucket: { count: 1, atLeast: false },
			},
			status,
			["user", "row", "column", "bucket", "file", "platform"],
		);
		expect(result.rows).toEqual([
			{ resource: "user", source: 7, target: 7, errors: 0 },
			{ resource: "row", source: 5000, target: 5001, errors: 2 },
			{ resource: "column", source: null, target: 4, errors: 0 },
			{ resource: "bucket", source: 1, target: 0, errors: 0 },
			{ resource: "file", source: 2, target: 1, errors: 0 },
		]);
		expect(result.mismatches).toEqual([
			{ resource: "bucket", source: 1, target: 0 },
			{ resource: "file", source: 2, target: 1 },
		]);
	});
});

describe("drivers' target version and import inputs", () => {
	it("Supabase reads the database image major; Appwrite uses the release", async () => {
		const { supabaseDriver } = await import("./supabase");
		const { appwriteDriver } = await import("./appwrite");
		const probe = (compose: string, backup: unknown) => ({
			templateId: "t",
			version: "2.3.0",
			manifest: { backup } as never,
			compose: async () => compose,
		});
		expect(
			await supabaseDriver.targetVersion(
				probe("services:\n  db:\n    image: supabase/postgres:17.6.1.136\n", {
					database: "db",
				}),
			),
		).toBe("17");
		expect(
			await supabaseDriver.targetVersion(probe("services: {}\n", {})),
		).toBeNull();
		expect(await appwriteDriver.targetVersion(probe("", {}))).toBe("2.3.0");
		expect(
			appwriteDriver.importInputs?.({ pluginConfig: plugin, email: "a@b.co" }),
		).toEqual({ CONSOLE_ADMIN_EMAIL: "a@b.co" });
		expect(() =>
			appwriteDriver.importInputs?.({ pluginConfig: plugin, email: null }),
		).toThrow(AppError);
	});
});
