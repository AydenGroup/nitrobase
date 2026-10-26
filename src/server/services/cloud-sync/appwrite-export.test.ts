import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppwritePluginConfig } from "#/features/appwrite/schema.ts";
import { gatewayUrl } from "#/server/services/gateway.ts";
import { AppError } from "#/utils/error.ts";

const cloudRequest = vi.fn();
vi.mock("./http", async (original) => ({
	...(await original<typeof import("./http")>()),
	cloudRequest: (...args: unknown[]) => cloudRequest(...args),
}));

const { appwriteCloud, countEmptiness } = await import("./appwrite-api");
const { encodeQueries, localRequests } = await import("./appwrite-local");
const { analyzeAppwriteExport, newerByMinor } = await import(
	"./appwrite-preflight"
);
const { checkReachability, isExportRecovery, sourceEndpoint } = await import(
	"./appwrite-export"
);

const plugin: AppwritePluginConfig = {
	api_service: "appwrite",
	api_port: 80,
	api_path: "/v1",
	console_project: "console",
	console_email: "CONSOLE_ADMIN_EMAIL",
	console_password: "CONSOLE_ADMIN_PASSWORD",
	sync_key_scopes: ["migrations.read", "migrations.write"],
	sync_export_key_scopes: ["users.read", "buckets.read"],
	sync_cloud_key_scopes: ["migrations.read", "migrations.write"],
	sync_resources: { auth: ["user", "team"], storage: ["bucket", "file"] },
};

const provider = {
	id: "appwrite",
	allowedHosts: ["*.cloud.appwrite.io"],
} as never;
const config = {
	endpoint: "https://fra.cloud.appwrite.io/v1",
	projectId: "cloudproj",
	apiKey: "standard_secret",
};

const facts = (
	patch: Partial<Parameters<typeof analyzeAppwriteExport>[0]> = {},
) => ({
	parts: ["auth"],
	cloudProjectId: "cloudproj",
	localProjectId: "localproj",
	localVersion: "1.8.0",
	cloudVersion: "1.8.1",
	cloud: { user: 0, team: 0, database: 0, bucket: 0, function: 0 },
	cloudRefused: [],
	canWrite: true,
	cloudScopes: ["migrations.read", "migrations.write"],
	reachability: { kind: "ok" } as const,
	givenKey: false,
	refused: [],
	partial: false,
	...patch,
});

const codes = (items: { code: string | null }[]) =>
	items.map((item) => item.code);

afterEach(() => cloudRequest.mockReset());

describe("Appwrite export versions", () => {
	it("blocks an app newer than the cloud by a minor or more", () => {
		expect(newerByMinor("1.8.1", "1.8.0")).toBe(false);
		expect(newerByMinor("1.8.0", "1.9.2")).toBe(false);
		expect(newerByMinor("1.9.0", "1.8.5")).toBe(true);
		expect(newerByMinor("2.0.0", "1.9.9")).toBe(true);
		expect(newerByMinor("nope", "1.8.0")).toBeNull();
	});
});

describe("Appwrite export preflight", () => {
	it("passes for an empty, writable, reachable cloud project", () => {
		const result = analyzeAppwriteExport(facts());
		expect(result.blockers).toEqual([]);
		expect(codes(result.warnings)).toEqual(
			expect.arrayContaining([
				"CLOUD_WARN_APPWRITE_EXPORT_ENDPOINT",
				"CLOUD_WARN_APPWRITE_EXPORT_REDO",
				"CLOUD_WARN_APPWRITE_EXPORT_LIVE",
			]),
		);
	});

	it("refuses a non-empty or unreadable project and a key without write", () => {
		const result = analyzeAppwriteExport(
			facts({
				cloud: { user: 2, team: 0, database: 1, bucket: 0, function: 0 },
				cloudRefused: ["function"],
				canWrite: false,
			}),
		);
		expect(codes(result.blockers)).toEqual([
			"CLOUD_EXPORT_NOT_EMPTY",
			"CLOUD_EXPORT_EMPTINESS_UNKNOWN",
			"CLOUD_EXPORT_KEY_NO_WRITE",
		]);
		expect(result.blockers[0].params).toEqual({
			items: { $list: ["user: 2", "database: 1"] },
		});
	});

	it("refuses a newer app and an address the cloud cannot read", () => {
		expect(
			codes(
				analyzeAppwriteExport(
					facts({ localVersion: "1.9.0", reachability: { kind: "no_url" } }),
				).blockers,
			),
		).toEqual(["CLOUD_EXPORT_RELEASE_NEWER", "CLOUD_EXPORT_NO_PUBLIC_URL"]);
		expect(
			codes(
				analyzeAppwriteExport(
					facts({
						reachability: {
							kind: "unreachable",
							url: "https://x.sslip.io/v1/health/version",
							detail: "certificate",
						},
					}),
				).blockers,
			),
		).toEqual(["CLOUD_EXPORT_SOURCE_UNREACHABLE"]);
		const mismatch = analyzeAppwriteExport(
			facts({ reachability: { kind: "mismatch", url: "u", found: "1.7.0" } }),
		);
		expect(mismatch.blockers[0]).toMatchObject({
			code: "CLOUD_EXPORT_SOURCE_MISMATCH",
			params: { expected: "1.8.0", found: "1.7.0" },
		});
		const skipped = analyzeAppwriteExport(
			facts({ reachability: { kind: "skipped" }, givenKey: true }),
		);
		expect(skipped.blockers).toEqual([]);
		expect(codes(skipped.warnings)).toEqual(
			expect.arrayContaining([
				"CLOUD_WARN_EXPORT_REACHABILITY_SKIPPED",
				"CLOUD_WARN_APPWRITE_EXPORT_GIVEN_KEY",
			]),
		);
	});

	it("checks the public address only when there is one", async () => {
		expect(sourceEndpoint(null, plugin)).toBeNull();
		expect(sourceEndpoint("https://app.example.com/", plugin)).toBe(
			"https://app.example.com/v1",
		);
		expect(await checkReachability(null, plugin, "1.8.0")).toEqual({
			kind: "no_url",
		});
		// Private and plain-http addresses are refused like the cloud would.
		const local = await checkReachability(
			"http://127.0.0.1:9/v1",
			plugin,
			"1.8.0",
		);
		expect(local.kind).toBe("unreachable");
	});
});

describe("Appwrite export requests", () => {
	it("sends list queries through the gateway, percent-encoded", () => {
		const request = localRequests.list(
			plugin,
			{ kind: "key", project: "p", secret: "s" },
			"/users",
			['{"method":"limit","values":[1]}'],
		);
		expect(request.path).toBe("/users");
		expect(request.query).toBe(
			"queries%5B%5D=%7B%22method%22%3A%22limit%22%2C%22values%22%3A%5B1%5D%7D",
		);
		expect(
			gatewayUrl({
				container: "app-appwrite",
				port: 80,
				path: request.path,
				query: request.query,
			}),
		).toBe(`http://app-appwrite:80/users?${request.query}`);
		expect(encodeQueries([])).toBe("");
		// The path itself still refuses a query; the query only its alphabet.
		expect(() =>
			gatewayUrl({ container: "a", port: 80, path: "/x?a=b" }),
		).toThrow();
		expect(() =>
			gatewayUrl({ container: "a", port: 80, path: "/x", query: "a=b c" }),
		).toThrow();
		expect(() =>
			gatewayUrl({ container: "a", port: 80, path: "/x", query: "a#b" }),
		).toThrow();
	});

	it("creates the temporary key with the export's read scopes", () => {
		const request = localRequests.createKey(plugin, "a_session_console=c", {
			projectId: "p",
			name: "export",
			expire: "2030-01-01T00:00:00.000Z",
			scopes: plugin.sync_export_key_scopes,
		});
		expect((request.body as { scopes: string[] }).scopes).toEqual([
			"users.read",
			"buckets.read",
		]);
	});

	it("starts the migration on the cloud with the app as its source", async () => {
		cloudRequest.mockResolvedValue({
			status: 202,
			headers: {},
			body: Buffer.from('{"$id":"m1","status":"pending"}'),
		});
		const cloud = appwriteCloud(provider, config);
		const result = await cloud.startMigration({
			endpoint: "https://app.example.com/v1",
			projectId: "localproj",
			apiKey: "local_key",
			resources: ["user"],
		});
		expect(result).toMatchObject({ $id: "m1" });
		const [, request] = cloudRequest.mock.calls[0];
		expect(request).toMatchObject({
			url: "https://fra.cloud.appwrite.io/v1/migrations/appwrite",
			method: "POST",
			headers: {
				"x-appwrite-project": "cloudproj",
				"x-appwrite-key": "standard_secret",
			},
		});
		expect(JSON.parse(request.body)).toEqual({
			resources: ["user"],
			endpoint: "https://app.example.com/v1",
			projectId: "localproj",
			apiKey: "local_key",
			onDuplicate: "fail",
		});
	});

	it("tells a key without migrations.write from other refusals", async () => {
		const cloud = appwriteCloud(provider, config);
		cloudRequest.mockRejectedValueOnce(
			new AppError("CLOUD_API_UNAUTHORIZED", {
				detail: '{"type":"general_unauthorized_scope","code":401}',
			}),
		);
		expect(await cloud.canStartMigrations()).toBe(false);
		cloudRequest.mockRejectedValueOnce(
			new AppError("CLOUD_API_FAILED", {
				status: 400,
				detail: '{"type":"general_argument_invalid"}',
			}),
		);
		expect(await cloud.canStartMigrations()).toBe(true);
		const [, probe] = cloudRequest.mock.calls[0];
		expect(probe.url).toContain("/migrations/appwrite/report?");
		expect(probe.url).not.toContain("standard_secret");
	});

	it("counts what the cloud project holds, refused reads apart", async () => {
		const api = {
			version: async () => "1.8.0",
			projectName: async () => null,
			list: async (path: string) => {
				if (path === "/functions") {
					throw new AppError("CLOUD_API_UNAUTHORIZED", { detail: "" });
				}
				return {
					total: path === "/users" ? 3 : path === "/project/platforms" ? 2 : 0,
					items: [],
				};
			},
		};
		expect(await countEmptiness(api)).toEqual({
			counts: { user: 3, team: 0, bucket: 0, database: 0, platform: 2 },
			refused: ["function"],
		});
	});

	it("counts no platforms where a key cannot list them (older Appwrite)", async () => {
		const api = {
			version: async () => "1.6.0",
			projectName: async () => null,
			list: async (path: string) => {
				if (path === "/project/platforms") {
					throw new AppError("CLOUD_API_FAILED", { status: 404, detail: "" });
				}
				return { total: 0, items: [] };
			},
		};
		expect((await countEmptiness(api)).counts.platform).toBe(0);
	});

	it("recognises an export's recovery state", () => {
		expect(
			isExportRecovery({
				direction: "export",
				localProjectId: "p",
				localKeyId: null,
				cloudMigrationId: "m",
			}),
		).toBe(true);
		expect(
			isExportRecovery({ projectId: "p", keyId: null, migrationId: null }),
		).toBe(false);
	});
});
