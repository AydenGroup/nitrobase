import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * API v1 routes an AI agent operates apps with: each calls the feature
 * function its UI server function calls, with the token's actor, and the
 * env route never returns secret values.
 */

const calls = vi.hoisted(() => [] as { fn: string; args: unknown[] }[]);
const { SECRET, SERVER_ID, APP_ID, SOURCE_TYPES } = vi.hoisted(() => ({
	APP_ID: "00000000-0000-4000-8000-000000000001",
	SOURCE_TYPES: {
		database: "database",
		"my-repo": "git",
		"my-compose": "inline",
	} as Record<string, string>,
	SECRET: "s3cr3t-value",
	SERVER_ID: "00000000-0000-4000-8000-000000000002",
}));

const record =
	(fn: string, result: unknown = null) =>
	async (...args: unknown[]) => {
		calls.push({ fn, args });
		return typeof result === "function" ? result(...args) : result;
	};

const preflight = vi.hoisted(() => ({ ok: true }));

vi.mock("#/features/apps/app-jobs.server.ts", () => ({
	startAppAction: record("startAppAction", { deploymentId: "job-1" }),
	createAndDeployApp: record("createAndDeployApp", {
		appId: "app-1",
		deploymentId: "job-2",
	}),
}));
vi.mock("#/features/apps/apps.server.ts", () => ({
	getAppOverview: async () => null,
	listApps: async () => [],
	listAppDeployments: record("listAppDeployments", []),
	getAppRow: record("getAppRow", async (_actor: unknown, appId: string) => {
		if (appId !== APP_ID) {
			const { AppError } = await import("#/utils/error.ts");
			throw new AppError("APP_NOT_FOUND");
		}
		return { id: APP_ID };
	}),
	getAppEnvForApi: record("getAppEnvForApi", {
		text: "PUBLIC=1\nPASSWORD=••••••••",
		variables: [{ name: "PASSWORD", secret: true }],
		needsRedeploy: false,
		version: "v1",
	}),
	// Must never be reached by the API: it returns plain secrets.
	revealAppEnv: record("revealAppEnv", `PASSWORD=${SECRET}`),
	appOverrides: () => ({ PASSWORD: SECRET }),
}));
vi.mock("#/features/apps/logs.server.ts", () => ({
	readAppLogs: record(
		"readAppLogs",
		async (_actor: unknown, input: { appId: string }) => {
			if (input.appId !== APP_ID) {
				const { AppError } = await import("#/utils/error.ts");
				throw new AppError("APP_NOT_FOUND");
			}
			return { service: null, tail: 200, text: "", truncated: false };
		},
	),
}));
vi.mock("#/features/apps/preflight.server.ts", () => ({
	runPreflight: record("runPreflight", () => ({ ...preflight, checks: [] })),
}));
vi.mock("#/features/backups/jobs.server.ts", () => ({
	startAppBackup: async () => null,
}));
vi.mock("#/features/backups/backups.server.ts", () => ({
	listBackups: record("listBackups", []),
}));
vi.mock("#/features/backups/destinations.server.ts", () => ({
	listDestinations: record("listDestinations", [
		{
			id: "d-1",
			name: "Offsite",
			type: "s3",
			config: { accessKeyId: "AKIA", secretAccessKey: SECRET },
			backups: 3,
		},
	]),
}));
vi.mock("#/features/deployments/jobs.server.ts", () => ({
	listJobs: record("listJobs", []),
}));
vi.mock("#/features/monitoring/monitoring.server.ts", () => ({
	serverHistory: record("serverHistory", { points: [] }),
}));
vi.mock("#/features/servers/servers.server.ts", () => ({
	getDeployment: async () => null,
	getServer: record("getServer", (_actor: unknown, serverId: string) =>
		serverId === SERVER_ID ? { id: SERVER_ID } : null,
	),
	listServers: async () => [],
	listServerSummaries: record("listServerSummaries", {
		servers: [{ serverId: SERVER_ID, appCount: 2, databaseCount: 1 }],
		thresholds: { diskPercent: 90, memoryPercent: 90 },
	}),
}));
vi.mock("#/features/templates/templates.server.ts", () => ({
	getTemplateManifest: async (templateId: string) => ({
		source: { type: SOURCE_TYPES[templateId] ?? "github" },
	}),
	listTemplates: record("listTemplates", []),
	getTemplateVersions: record("getTemplateVersions", {
		versions: [],
		defaultRef: null,
	}),
}));

// The REST handler around the registry: tokens map to permission sets.
vi.mock("#/config/server.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	appBaseUrl: () => null,
	getConfig: () => ({ API_RATE_LIMIT: 10_000, API_RATE_WINDOW_MS: 60_000 }),
}));
vi.mock("#/server/services/request-info.ts", () => ({
	currentRequestInfo: () => ({ ip: "203.0.113.7" }),
}));
vi.mock("#/server/services/audit.ts", () => ({ audit: () => {} }));
vi.mock("#/features/deployments/stream.server.ts", () => ({
	deploymentStreamResponse: async () => new Response(null),
}));
vi.mock("#/features/tokens/tokens.server.ts", async () => {
	const { withImplied } = await import("#/config/permissions.ts");
	const grants: Record<string, string[]> = {
		nbk_viewer: ["app.view"],
		nbk_deployer: ["app.deploy"],
	};
	return {
		tokenPublicPart: () => null,
		authenticateToken: async (bearer: string) =>
			grants[bearer]
				? {
						userId: null,
						teamId: "t-1",
						role: null,
						permissions: new Set(withImplied(grants[bearer] as never[])),
						instanceAdmin: false,
						via: "token",
						tokenId: bearer,
					}
				: null,
	};
});

const { matchApiRoute, openApiDocument } = await import("./v1");
const { handleApiRequest } = await import("./v1-handler");
const { NAME_MAX_LENGTH } = await import("#/config/shared.ts");

/** One `/api/v1` request through the real handler. */
async function request(
	token: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const response = await handleApiRequest(
		new Request(`http://localhost/api/v1${path}`, {
			method,
			headers: { authorization: `Bearer ${token}` },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		path.slice(1),
	);
	return { status: response.status, json: await response.json() };
}

const actor = { userId: "u-1", teamId: "t-1" } as never;

function find(method: string, path: string) {
	const match = matchApiRoute(method, path);
	if (!match || match === "method") throw new Error(`no ${method} ${path}`);
	return match;
}

async function call(method: string, path: string, body: unknown = {}) {
	const { route, params } = find(method, path);
	return route.handler({
		actor,
		params: route.params.parse(params),
		body: route.body?.parse(body) ?? {},
		request: new Request("http://localhost", {
			headers: { "accept-language": "en" },
		}),
	});
}

const routes = [
	["listAppDeployments", "GET", `/apps/${APP_ID}/deployments`, "app.view"],
	["getAppLogs", "POST", `/apps/${APP_ID}/logs`, "app.view"],
	["startApp", "POST", `/apps/${APP_ID}/start`, "app.deploy"],
	["stopApp", "POST", `/apps/${APP_ID}/stop`, "app.deploy"],
	["getAppEnv", "GET", `/apps/${APP_ID}/env`, "app.view"],
	["listTemplates", "GET", "/templates", "app.view"],
	["listTemplateVersions", "GET", "/templates/ghost/versions", "app.view"],
	["preflightApp", "POST", "/apps/preflight", "app.deploy"],
	["createApp", "POST", "/apps", "app.deploy"],
	["getServerHealth", "GET", `/servers/${SERVER_ID}/health`, "server.view"],
	[
		"getServerMetrics",
		"GET",
		`/servers/${SERVER_ID}/metrics/24h`,
		"monitoring.view",
	],
	["listAppBackups", "GET", `/apps/${APP_ID}/backups`, "backup.view"],
	["listBackupDestinations", "GET", "/backups/destinations", "backup.view"],
	["listJobs", "GET", "/jobs", "server.view"],
] as const;

beforeEach(() => {
	calls.length = 0;
	preflight.ok = true;
});

describe("operating routes", () => {
	it.each(
		routes,
	)("%s is matched and documented with its permission", (routeId, method, path, permission) => {
		const { route } = find(method, path);
		expect(route.id).toBe(routeId);
		expect(route.permission).toBe(permission);
		const doc = openApiDocument("https://panel.example.com") as {
			paths: Record<string, Record<string, Record<string, unknown>>>;
		};
		const operation = doc.paths[route.path]?.[method.toLowerCase()];
		expect(operation?.operationId).toBe(routeId);
		expect(operation?.["x-permission"]).toBe(permission);
	});

	it("keeps the existing routes on shared paths", () => {
		expect(find("GET", "/apps").route.id).toBe("listApps");
		expect(find("POST", `/apps/${APP_ID}/backups`).route.id).toBe("backupApp");
		expect(find("GET", `/apps/${APP_ID}`).route.id).toBe("getApp");
	});

	it("rejects bad params and bodies", () => {
		const bad = (method: string, path: string, body?: unknown) => {
			const { route, params } = find(method, path);
			const okParams = route.params.safeParse(params).success;
			const okBody =
				body === undefined || !route.body || route.body.safeParse(body).success;
			return !(okParams && okBody);
		};
		expect(bad("GET", "/apps/not-a-uuid/deployments")).toBe(true);
		expect(bad("GET", "/apps/not-a-uuid/env")).toBe(true);
		expect(bad("GET", `/servers/${SERVER_ID}/metrics/1y`)).toBe(true);
		expect(bad("GET", "/templates/Bad Id!/versions")).toBe(true);
		expect(bad("POST", `/apps/${APP_ID}/logs`, { tail: 0 })).toBe(true);
		expect(bad("POST", `/apps/${APP_ID}/logs`, { tail: 1.5 })).toBe(true);
		expect(bad("POST", `/apps/${APP_ID}/logs`, { service: "-x; rm" })).toBe(
			true,
		);
		expect(bad("POST", `/apps/${APP_ID}/stop`, { service: "a b" })).toBe(true);
		expect(bad("POST", "/apps", { templateId: "ghost" })).toBe(true);
		expect(
			bad("POST", "/apps", {
				templateId: "ghost",
				serverId: "nope",
				name: "Blog",
			}),
		).toBe(true);
	});
});

describe("handlers pass the token's actor to the feature functions", () => {
	it("start/stop map to the app actions", async () => {
		await call("POST", `/apps/${APP_ID}/start`);
		await call("POST", `/apps/${APP_ID}/stop`, { service: "db" });
		expect(calls).toEqual([
			{
				fn: "startAppAction",
				args: [actor, { appId: APP_ID, action: "start", service: undefined }],
			},
			{
				fn: "startAppAction",
				args: [actor, { appId: APP_ID, action: "stop", service: "db" }],
			},
		]);
	});

	it("reads logs, deployments, backups and jobs as the actor", async () => {
		await call("POST", `/apps/${APP_ID}/logs`, { service: "web", tail: 50 });
		await call("GET", `/apps/${APP_ID}/deployments`);
		await call("GET", `/apps/${APP_ID}/backups`);
		await call("GET", "/jobs");
		expect(calls.map(({ fn, args }) => [fn, args[0]])).toEqual([
			["readAppLogs", actor],
			["listAppDeployments", actor],
			["getAppRow", actor],
			["listBackups", actor],
			["listJobs", actor],
		]);
		expect(calls[0].args[1]).toEqual({
			appId: APP_ID,
			service: "web",
			tail: 50,
		});
		expect(calls[2].args.slice(1)).toEqual([APP_ID, "backup.view"]);
		expect(calls[3].args[1]).toEqual({ appId: APP_ID });
		expect(calls[4].args[1]).toMatchObject({ limit: expect.any(Number) });
	});

	it("lists backups of the actor's apps only", async () => {
		const other = "00000000-0000-4000-8000-000000000009";
		await expect(call("GET", `/apps/${other}/backups`)).rejects.toMatchObject({
			code: "APP_NOT_FOUND",
		});
		expect(calls.map(({ fn }) => fn)).toEqual(["getAppRow"]);
	});

	it("returns the masked env, never the revealed one", async () => {
		const result = await call("GET", `/apps/${APP_ID}/env`);
		expect(calls.map(({ fn }) => fn)).toEqual(["getAppEnvForApi"]);
		expect(calls[0].args).toEqual([actor, APP_ID]);
		expect(JSON.stringify(result)).not.toContain(SECRET);
		expect(find("GET", `/apps/${APP_ID}/env`).route.permission).not.toBe(
			"app.env.reveal",
		);
	});

	it("lists destinations without their config", async () => {
		const result = await call("GET", "/backups/destinations");
		expect(result).toEqual([{ id: "d-1", name: "Offsite", type: "s3" }]);
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("scopes server health and metrics to the actor's servers", async () => {
		await expect(
			call("GET", `/servers/${SERVER_ID}/health`),
		).resolves.toMatchObject({ serverId: SERVER_ID, appCount: 2 });
		await call("GET", `/servers/${SERVER_ID}/metrics/7d`);
		expect(calls.at(-1)).toEqual({
			fn: "serverHistory",
			args: [SERVER_ID, "7d"],
		});
		const other = "00000000-0000-4000-8000-000000000009";
		await expect(call("GET", `/servers/${other}/health`)).rejects.toThrow();
		await expect(call("GET", `/servers/${other}/metrics/1h`)).rejects.toThrow();
		expect(
			calls.filter(({ fn }) => fn === "getServer").map(({ args }) => args[0]),
		).toEqual([actor, actor, actor, actor]);
	});

	it("creates an app only after a passing pre-flight", async () => {
		const body = {
			templateId: "ghost",
			serverId: SERVER_ID,
			name: "Blog",
			domain: "",
			inputs: { ADMIN_EMAIL: "a@example.com" },
		};
		await expect(call("POST", "/apps", body)).resolves.toEqual({
			appId: "app-1",
			deploymentId: "job-2",
		});
		expect(calls.map(({ fn, args }) => [fn, args[0]])).toEqual([
			["runPreflight", actor],
			["createAndDeployApp", actor],
		]);
		expect(calls[0].args[1]).toMatchObject({ domain: undefined });
		expect(calls[1].args[1]).toMatchObject({
			templateId: "ghost",
			serverId: SERVER_ID,
			name: "Blog",
			acknowledged: false,
			inputs: { ADMIN_EMAIL: "a@example.com" },
		});

		calls.length = 0;
		preflight.ok = false;
		await expect(call("POST", "/apps", body)).resolves.toEqual({
			preflight: { ok: false, checks: [] },
		});
		expect(calls.map(({ fn }) => fn)).toEqual(["runPreflight"]);
	});
});

describe("through the REST handler", () => {
	it("refuses a token without the route's permission (403)", async () => {
		const { status, json } = await request(
			"nbk_viewer",
			"POST",
			`/apps/${APP_ID}/stop`,
		);
		expect(status).toBe(403);
		expect(json).toMatchObject({
			error: "forbidden",
			permission: "app.deploy",
		});
		expect(calls).toEqual([]);
	});

	it("maps feature AppErrors to HTTP (404 for another team's app)", async () => {
		const other = "00000000-0000-4000-8000-000000000009";
		const { status, json } = await request(
			"nbk_viewer",
			"POST",
			`/apps/${other}/logs`,
			{ tail: 10 },
		);
		expect(status).toBe(404);
		expect(json.error).toBe("APP_NOT_FOUND");
	});

	it("answers 400 for invalid input", async () => {
		const { status, json } = await request(
			"nbk_viewer",
			"POST",
			`/apps/${APP_ID}/logs`,
			{ tail: -1 },
		);
		expect(status).toBe(400);
		expect(json.error).toBe("bad_request");
		expect(calls).toEqual([]);
	});

	it("refuses a too long name with 400 before the pre-flight", async () => {
		const { status, json } = await request("nbk_deployer", "POST", "/apps", {
			templateId: "ghost",
			serverId: SERVER_ID,
			name: "x".repeat(NAME_MAX_LENGTH + 1),
		});
		expect(status).toBe(400);
		expect(json.error).toBe("bad_request");
		expect(calls).toEqual([]);
	});

	it.each([
		"database",
		"my-repo",
		"my-compose",
	])("refuses to create from the %s template (not a marketplace one)", async (templateId) => {
		const body = {
			templateId,
			serverId: SERVER_ID,
			name: "Data",
			version: "postgres@16",
		};
		const created = await request("nbk_deployer", "POST", "/apps", body);
		expect(created.status).toBe(400);
		expect(created.json).toMatchObject({ error: "TEMPLATE_API_UNSUPPORTED" });
		expect(String(created.json.message)).toContain(templateId);
		const checked = await request(
			"nbk_deployer",
			"POST",
			"/apps/preflight",
			body,
		);
		expect(checked.json.error).toBe("TEMPLATE_API_UNSUPPORTED");
		expect(calls).toEqual([]);
	});
});
