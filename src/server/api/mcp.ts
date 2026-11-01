import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	DEFAULT_MAX_REQUEST_BODY_SIZE,
	readRequestBody,
	requestBodyTooLargeMessage,
} from "@modelcontextprotocol/sdk/server/requestBody.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
	CallToolResult,
	ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { APP_ID, APP_NAME } from "#/config/shared.ts";
import { APP_VERSION } from "#/config/version.ts";
import { type Actor, can } from "#/features/auth/access.ts";
import { authenticateBearer } from "./bearer";
import { type ApiOutcome, runApiRoute } from "./run";
import { type ApiRoute, apiRoutes } from "./v1";

/**
 * `/api/mcp`: Model Context Protocol server for AI agents, with the same
 * `nbk_…` tokens as the REST API. Its tools are generated from the REST
 * registry (#/server/api/v1.ts): one tool per entry (stream entries
 * excepted), listed only when the token holds the entry's permission, run
 * through the same checks as REST (./run.ts). Stateless Streamable HTTP:
 * a fresh server and transport per POST, JSON responses, one message per
 * POST (no JSON-RPC batches: each POST counts once against the token's
 * rate limit, and batching left the spec in 2025-06-18).
 */

export interface McpTool {
	name: string;
	description: string;
	inputSchema: z.ZodObject;
	annotations: ToolAnnotations;
	route: ApiRoute;
}

/** `listServers` → `list_servers`. */
export const mcpToolName = (id: string) =>
	id.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

function shapeOf(route: ApiRoute, schema: z.ZodType | undefined) {
	if (!schema) return {};
	if (!(schema instanceof z.ZodObject)) {
		throw new Error(`[mcp] ${route.id}: params and body must be z.object`);
	}
	return schema.shape;
}

/** Hints from the method; the entry's `mcp` field overrides them. */
function annotationsOf(route: ApiRoute): ToolAnnotations {
	if (route.mcp?.readOnly ?? route.method === "GET") {
		return { readOnlyHint: true };
	}
	return {
		readOnlyHint: false,
		destructiveHint: route.mcp?.destructive ?? true,
		idempotentHint: route.mcp?.idempotent ?? false,
	};
}

/**
 * The tools of a registry: params and body merged into one input. Throws
 * on an entry that cannot be a tool (non-object schemas, a key in both
 * params and body, two ids with the same tool name); the registry test
 * runs it on the real registry so that fails in CI.
 */
export function mcpTools(routes: readonly ApiRoute[] = apiRoutes): McpTool[] {
	const names = new Set<string>();
	return routes
		.filter((route) => !route.stream)
		.map((route) => {
			const name = mcpToolName(route.id);
			if (names.has(name)) {
				throw new Error(`[mcp] ${route.id}: duplicate tool name ${name}`);
			}
			names.add(name);
			const params = shapeOf(route, route.params);
			const body = shapeOf(route, route.body);
			const shared = Object.keys(params).filter((key) => key in body);
			if (shared.length) {
				throw new Error(
					`[mcp] ${route.id}: ${shared.join(", ")} in both params and body`,
				);
			}
			return {
				name,
				description: `${route.summary}. Requires the \`${route.permission}\` permission.`,
				inputSchema: z.object({ ...params, ...body }),
				annotations: annotationsOf(route),
				route,
			};
		});
}

/** Tools per registry, built once (not per POST). */
const toolCache = new WeakMap<readonly ApiRoute[], McpTool[]>();
function toolsOf(routes: readonly ApiRoute[]): McpTool[] {
	let tools = toolCache.get(routes);
	if (!tools) {
		tools = mcpTools(routes);
		toolCache.set(routes, tools);
	}
	return tools;
}

function instructionsFor(routes: readonly ApiRoute[]): string {
	const job = routes.find((route) => route.id === "getJob");
	const poll = job
		? ` Tools that start work (deploy, restart, backup, start, stop, create...) return a job id at once: when your token has ${job.permission}, poll ${mcpToolName(job.id)} until it finishes.`
		: "";
	return `${APP_NAME} is a self-hosted platform that deploys and operates apps on the team's servers. Tools act on the team of the API token and are limited to its permissions.${poll} Tools that are not read-only change running production apps: confirm with the user before calling them.`;
}

const rpcError = (
	status: number,
	code: number,
	message: string,
	headers?: HeadersInit,
) =>
	Response.json(
		{ jsonrpc: "2.0", error: { code, message }, id: null },
		{ status, headers },
	);

/** The POST's single JSON-RPC message, or the error response. */
async function readMessage(
	request: Request,
): Promise<{ message: unknown } | Response> {
	const body = await readRequestBody(request, DEFAULT_MAX_REQUEST_BODY_SIZE);
	if (body.tooLarge) {
		return rpcError(
			413,
			-32000,
			requestBodyTooLargeMessage(DEFAULT_MAX_REQUEST_BODY_SIZE),
		);
	}
	let message: unknown;
	try {
		message = JSON.parse(body.text);
	} catch {
		return rpcError(400, -32700, "Parse error: Invalid JSON");
	}
	if (Array.isArray(message)) {
		return rpcError(400, -32600, "Invalid Request: batching is not supported");
	}
	return { message };
}

function toolResult(outcome: ApiOutcome): CallToolResult {
	const value = outcome.ok ? outcome.value : outcome.body;
	const structured =
		value && typeof value === "object" && !Array.isArray(value)
			? { structuredContent: value as Record<string, unknown> }
			: {};
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
		...structured,
		...(outcome.ok ? {} : { isError: true }),
	};
}

/** An MCP server exposing the tools `actor` may run. */
export function createMcpServer(
	actor: Actor,
	request: Request,
	routes: readonly ApiRoute[] = apiRoutes,
): McpServer {
	const server = new McpServer(
		{ name: APP_ID, title: APP_NAME, version: APP_VERSION },
		{ capabilities: { tools: {} }, instructions: instructionsFor(routes) },
	);
	for (const tool of toolsOf(routes)) {
		if (!can(actor, tool.route.permission)) continue;
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
			},
			async (args: Record<string, unknown>) =>
				toolResult(
					await runApiRoute(
						actor,
						tool.route,
						{ params: args, body: async () => ({ ok: true, value: args }) },
						request,
						`mcp ${tool.name}`,
					),
				),
		);
	}
	return server;
}

/** Handle one `/api/mcp` request. */
export async function handleMcpRequest(
	request: Request,
	routes: readonly ApiRoute[] = apiRoutes,
): Promise<Response> {
	if (request.method !== "POST") {
		// Stateless: no standalone event stream (GET) nor session (DELETE).
		return rpcError(405, -32000, "Method not allowed", { Allow: "POST" });
	}
	const actor = await authenticateBearer(request, {
		path: new URL(request.url).pathname,
		channel: "mcp",
	});
	if (actor instanceof Response) return actor;
	const read = await readMessage(request);
	if (read instanceof Response) return read;
	let server: McpServer;
	try {
		server = createMcpServer(actor, request, routes);
	} catch (error) {
		// A registry entry that cannot be a tool (see mcpTools).
		console.error("[mcp] cannot build the tools", error);
		return rpcError(500, -32603, "Internal error");
	}
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(request, {
			parsedBody: read.message,
		});
	} finally {
		await server.close();
	}
}
