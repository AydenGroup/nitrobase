import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Permission } from "#/config/permissions.ts";
import type { Actor } from "#/features/auth/access.ts";

/**
 * MCP server (`/api/mcp`): tools generated from the REST registry, gated
 * by the token's permissions, run like REST (same auth, audit, errors).
 */

const state = vi.hoisted(() => ({
	audits: [] as Array<{ action: string; meta?: Record<string, unknown> }>,
	tokens: new Map<string, string[]>(),
	deployCalls: [] as unknown[],
	rateLimit: 1000,
}));

vi.mock("#/config/server.ts", () => ({
	getConfig: () => ({
		API_RATE_LIMIT: state.rateLimit,
		API_RATE_WINDOW_MS: 60_000,
	}),
	appBaseUrl: () => null,
}));
vi.mock("#/server/services/request-info.ts", () => ({
	currentRequestInfo: () => ({ ip: "203.0.113.7", userAgent: "vitest" }),
}));
vi.mock("#/server/services/audit.ts", () => ({
	audit: (event: { action: string; meta?: Record<string, unknown> }) =>
		state.audits.push(event),
}));
vi.mock("#/features/tokens/tokens.server.ts", () => ({
	authenticateToken: async (token: string): Promise<Actor | null> => {
		const granted = state.tokens.get(token);
		if (!granted) return null;
		return {
			userId: "user-1",
			teamId: "team-1",
			role: null,
			permissions: new Set(granted as Permission[]),
			instanceAdmin: false,
			via: "token",
			tokenId: `id-${token}`,
		};
	},
	tokenPublicPart: (token: string) =>
		token.startsWith("nbk_") ? token.slice(0, 8) : null,
}));
vi.mock("#/features/apps/app-jobs.server.ts", () => ({
	startAppAction: async (_actor: unknown, input: unknown) => {
		state.deployCalls.push(input);
		return { deploymentId: "job-1" };
	},
}));
vi.mock("#/features/apps/apps.server.ts", () => ({
	getAppOverview: async () => null,
	listApps: async () => [{ id: "app-1", name: "Blog" }],
}));
vi.mock("#/features/backups/jobs.server.ts", () => ({
	startAppBackup: async () => null,
}));
vi.mock("#/features/servers/servers.server.ts", () => ({
	getDeployment: async () => null,
	// No server is found: the route turns that into SERVER_NOT_FOUND.
	getServer: async () => null,
	listServers: async () => [],
}));
vi.mock("#/features/deployments/stream.server.ts", () => ({
	deploymentStreamResponse: () => new Response("stream"),
}));

const { handleMcpRequest, mcpTools, mcpToolName } = await import("./mcp");
const { assertCanAccess } = await import("#/features/auth/access.ts");
const { runApiRoute } = await import("./run");
const { apiRoutes } = await import("./v1");
const { handleApiRequest } = await import("./v1-handler");
type ApiRoute = (typeof apiRoutes)[number];

const PANEL = "http://panel.test/api/mcp";
const SERVER_ID = "00000000-0000-4000-8000-000000000002";
const VIEW = "nbk_viewer";
const DEPLOY = "nbk_deployer";

async function connect(
	token: string,
	options: { routes?: ApiRoute[]; headers?: Record<string, string> } = {},
) {
	const transport = new StreamableHTTPClientTransport(new URL(PANEL), {
		requestInit: {
			headers: { authorization: `Bearer ${token}`, ...options.headers },
		},
		fetch: (input, init) =>
			handleMcpRequest(new Request(input, init), options.routes),
	});
	const client = new Client({ name: "vitest", version: "1" });
	await client.connect(transport);
	return client;
}

/** A raw POST to /api/mcp (body as given when a string). */
const post = (body: unknown, headers: Record<string, string> = {}) =>
	handleMcpRequest(
		new Request(PANEL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...headers,
			},
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);

const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
	(result.content as Array<{ text: string }>)[0]?.text ?? "";

const limits = globalThis as { __nitrobaseApiLimiters?: unknown };

afterEach(() => {
	state.rateLimit = 1000;
	delete limits.__nitrobaseApiLimiters;
});

beforeEach(() => {
	state.audits.length = 0;
	state.deployCalls.length = 0;
	state.tokens.clear();
	state.tokens.set(VIEW, ["server.view", "app.view"]);
	state.tokens.set(DEPLOY, ["server.view", "app.view", "app.deploy"]);
});

describe("tools from the registry", () => {
	it("names tools in snake_case and documents the permission", () => {
		expect(mcpToolName("listServers")).toBe("list_servers");
		const tools = mcpTools();
		const deploy = tools.find((tool) => tool.name === "deploy_app");
		expect(deploy?.description).toContain("Requires the `app.deploy`");
		// Params and body merged into one input.
		expect(Object.keys(deploy?.inputSchema.shape ?? {})).toEqual(
			expect.arrayContaining(["appId", "version", "confirmDowngrade"]),
		);
	});

	it("exposes every non-stream entry, and nothing else", () => {
		expect(mcpTools().map((tool) => tool.name)).toEqual(
			apiRoutes
				.filter((route) => !route.stream)
				.map((route) => mcpToolName(route.id)),
		);
		expect(mcpTools().some((tool) => tool.name === "stream_job")).toBe(false);
	});

	it("builds the real registry; refuses entries that cannot be tools", () => {
		expect(() => mcpTools(apiRoutes)).not.toThrow();
		const base = apiRoutes[0];
		expect(() => mcpTools([base, { ...base }])).toThrow(/duplicate tool name/);
		expect(() =>
			mcpTools([
				{
					...base,
					params: z.object({ appId: z.string() }),
					body: z.object({ appId: z.string() }),
				},
			]),
		).toThrow(/appId in both params and body/);
		expect(() => mcpTools([{ ...base, params: z.string() }])).toThrow(
			/z.object/,
		);
	});

	it("does not mark creating a backup as destructive", () => {
		const backup = mcpTools().find((tool) => tool.name === "backup_app");
		expect(backup?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
		});
	});

	it("derives annotations from the method; the entry can override them", () => {
		const [get, post, safe, read] = mcpTools([
			{ ...apiRoutes[0], method: "GET" },
			{ ...apiRoutes[0], id: "doIt", method: "POST" },
			{
				...apiRoutes[0],
				id: "safeIt",
				method: "POST",
				mcp: { destructive: false, idempotent: true },
			},
			{
				...apiRoutes[0],
				id: "readIt",
				method: "POST",
				mcp: { readOnly: true },
			},
		]);
		expect(read.annotations).toEqual({ readOnlyHint: true });
		expect(get.annotations).toEqual({ readOnlyHint: true });
		expect(post.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(safe.annotations).toMatchObject({
			destructiveHint: false,
			idempotentHint: true,
		});
	});

	it("a new registry entry becomes a tool, run with gate and channel", async () => {
		const seen: Actor[] = [];
		const extra: ApiRoute = {
			id: "pingTeam",
			method: "POST",
			path: "/ping",
			permission: "app.view",
			summary: "Ping",
			params: z.object({}),
			body: z.object({ message: z.string() }),
			handler: async ({ actor, body }) => {
				seen.push(actor);
				return { echoed: (body as { message: string }).message };
			},
		};
		const client = await connect(VIEW, { routes: [...apiRoutes, extra] });
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toContain("ping_team");
		const result = await client.callTool({
			name: "ping_team",
			arguments: { message: "hi" },
		});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({ echoed: "hi" });
		expect(seen[0]).toMatchObject({
			gate: "app.view",
			channel: "mcp",
			tokenId: `id-${VIEW}`,
		});
	});
});

describe("POST /api/mcp", () => {
	it("lists only the tools the token may run, with their hints", async () => {
		const viewer = await connect(VIEW);
		const names = (await viewer.listTools()).tools.map((tool) => tool.name);
		expect(names).toEqual(
			expect.arrayContaining(["list_servers", "get_app", "get_job"]),
		);
		expect(names).not.toContain("deploy_app");
		expect(names).not.toContain("backup_app");

		const deployer = await connect(DEPLOY);
		const tools = (await deployer.listTools()).tools;
		const deploy = tools.find((tool) => tool.name === "deploy_app");
		expect(deploy?.annotations).toMatchObject({ destructiveHint: true });
		expect(
			tools.find((tool) => tool.name === "list_apps")?.annotations,
		).toMatchObject({ readOnlyHint: true });
		expect(deployer.getInstructions()).toContain(
			"when your token has server.view, poll get_job",
		);
	});

	it("runs a tool and returns its JSON result", async () => {
		const client = await connect(VIEW);
		const result = await client.callTool({ name: "list_apps", arguments: {} });
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(text(result))).toEqual([{ id: "app-1", name: "Blog" }]);
		// Arrays are not structured content (it must be an object).
		expect(result.structuredContent).toBeUndefined();
	});

	it("passes params and body of a POST tool to the route", async () => {
		const client = await connect(DEPLOY);
		const result = await client.callTool({
			name: "deploy_app",
			arguments: { appId: SERVER_ID, version: "2.3.0" },
		});
		expect(result.structuredContent).toEqual({ deploymentId: "job-1" });
		expect(state.deployCalls).toEqual([
			expect.objectContaining({ appId: SERVER_ID, version: "2.3.0" }),
		]);
	});

	it("refuses a tool the token lacks as an error result", async () => {
		const client = await connect(VIEW);
		const result = await client.callTool({
			name: "deploy_app",
			arguments: { appId: SERVER_ID },
		});
		expect(result.isError).toBe(true);
		expect(state.deployCalls).toEqual([]);
	});

	it("refuses invalid input as an error result", async () => {
		const client = await connect(VIEW);
		const result = await client.callTool({
			name: "get_server",
			arguments: { serverId: "not-a-uuid" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("serverId");
	});

	it("maps an AppError to its coded, translated message", async () => {
		const english = await connect(VIEW);
		const result = await english.callTool({
			name: "get_server",
			arguments: { serverId: SERVER_ID },
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			error: "SERVER_NOT_FOUND",
			message: "Server not found",
		});
		const vietnamese = await connect(VIEW, {
			headers: { "accept-language": "vi" },
		});
		const translated = await vietnamese.callTool({
			name: "get_server",
			arguments: { serverId: SERVER_ID },
		});
		expect(translated.structuredContent).toMatchObject({
			error: "SERVER_NOT_FOUND",
			message: "Không tìm thấy máy chủ",
		});
	});

	it("answers 401 without or with a bad token, audited like REST", async () => {
		const missing = await post(listTools);
		expect(missing.status).toBe(401);
		// No challenge: MCP clients would start OAuth discovery.
		expect(missing.headers.get("www-authenticate")).toBeNull();
		expect((await missing.json()).message).toContain(
			"Authorization: Bearer nbk_",
		);
		const invalid = await post(listTools, {
			authorization: "Bearer nbk_unknown",
		});
		expect(invalid.status).toBe(401);
		expect(state.audits).toEqual([
			expect.objectContaining({
				action: "api.auth_failed",
				meta: expect.objectContaining({ reason: "missing", channel: "mcp" }),
			}),
			expect.objectContaining({
				action: "api.auth_failed",
				meta: expect.objectContaining({
					reason: "invalid",
					prefix: "nbk_unkn",
					channel: "mcp",
				}),
			}),
		]);
	});

	it("refuses JSON-RPC batches and invalid JSON", async () => {
		const auth = { authorization: `Bearer ${VIEW}` };
		const batch = await post([listTools, { ...listTools, id: 2 }], auth);
		expect(batch.status).toBe(400);
		expect((await batch.json()).error).toMatchObject({
			code: -32600,
			message: expect.stringContaining("batching is not supported"),
		});
		const broken = await post("{not json", auth);
		expect(broken.status).toBe(400);
		expect((await broken.json()).error).toMatchObject({ code: -32700 });
	});

	it("rate limits each POST against the token", async () => {
		state.rateLimit = 2;
		delete limits.__nitrobaseApiLimiters;
		const auth = { authorization: `Bearer ${VIEW}` };
		expect((await post(listTools, auth)).status).toBe(200);
		expect((await post(listTools, auth)).status).toBe(200);
		const limited = await post(listTools, auth);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
	});

	it("refuses a listed tool once the permission is revoked", async () => {
		state.tokens.set("nbk_flaky", ["app.view", "app.deploy"]);
		const client = await connect("nbk_flaky");
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names).toContain("restart_app");
		state.tokens.set("nbk_flaky", ["app.view"]);
		const result = await client.callTool({
			name: "restart_app",
			arguments: { appId: SERVER_ID },
		});
		expect(result.isError).toBe(true);
		expect(state.deployCalls).toEqual([]);
	});

	it("returns the coded refusal of an in-call permission check", async () => {
		const guarded: ApiRoute = {
			id: "guardedThing",
			method: "POST",
			path: "/guarded",
			permission: "app.view",
			summary: "Guarded",
			params: z.object({}),
			handler: async ({ actor }) => {
				assertCanAccess(actor, "app.deploy");
				return { done: true };
			},
		};
		const client = await connect(VIEW, { routes: [...apiRoutes, guarded] });
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names).toContain("guarded_thing");
		const result = await client.callTool({
			name: "guarded_thing",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ error: "FORBIDDEN" });
	});

	it("answers 405 to GET and DELETE (stateless server)", async () => {
		for (const method of ["GET", "DELETE"]) {
			const response = await handleMcpRequest(new Request(PANEL, { method }));
			expect(response.status).toBe(405);
			expect(response.headers.get("allow")).toBe("POST");
		}
	});
});

describe("shared with REST", () => {
	it("refuses a route the actor lacks with the REST forbidden body", async () => {
		const deploy = apiRoutes.find((route) => route.id === "deployApp");
		if (!deploy) throw new Error("no deployApp");
		const outcome = await runApiRoute(
			{
				userId: null,
				teamId: "team-1",
				role: null,
				permissions: new Set(),
				instanceAdmin: false,
				via: "token",
			},
			deploy,
			{
				params: { appId: SERVER_ID },
				body: async () => ({ ok: true, value: {} }),
			},
			new Request(PANEL),
		);
		expect(outcome).toEqual({
			ok: false,
			status: 403,
			body: { error: "forbidden", permission: "app.deploy" },
		});
	});

	it("REST keeps its status codes and audits its failures as api", async () => {
		const rest = (path: string, token?: string) =>
			handleApiRequest(
				new Request(`http://panel.test/api/v1/${path}`, {
					headers: token ? { authorization: `Bearer ${token}` } : {},
				}),
				path,
			);
		const unauthorized = await rest("apps");
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");
		expect(state.audits[0]?.meta).toMatchObject({
			path: "/apps",
			channel: "api",
		});
		expect(await (await rest("apps", VIEW)).json()).toEqual([
			{ id: "app-1", name: "Blog" },
		]);
		const missing = await rest(`servers/${SERVER_ID}`, VIEW);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({
			error: "SERVER_NOT_FOUND",
			message: "Server not found",
		});
	});
});
