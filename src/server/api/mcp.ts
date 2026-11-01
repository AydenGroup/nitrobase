import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
 * a fresh server and transport per POST, JSON responses.
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

/** The tools of a registry: params and body merged into one input. */
export function mcpTools(routes: readonly ApiRoute[] = apiRoutes): McpTool[] {
	return routes
		.filter((route) => !route.stream)
		.map((route) => ({
			name: mcpToolName(route.id),
			description: `${route.summary}. Requires the \`${route.permission}\` permission.`,
			inputSchema: z.object({
				...shapeOf(route, route.params),
				...shapeOf(route, route.body),
			}),
			annotations: annotationsOf(route),
			route,
		}));
}

const jobTool = mcpToolName("getJob");

const instructions = `${APP_NAME} is a self-hosted platform that deploys and operates apps on the team's servers. Tools act on the team of the API token and are limited to its permissions. Deploy, restart and backup tools start a job and return its id at once: poll ${jobTool} until it finishes. Tools that are not read-only change running production apps: confirm with the user before calling them.`;

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
		{ capabilities: { tools: {} }, instructions },
	);
	for (const tool of mcpTools(routes)) {
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
		return Response.json(
			{
				jsonrpc: "2.0",
				error: { code: -32000, message: "Method not allowed" },
				id: null,
			},
			{ status: 405, headers: { Allow: "POST" } },
		);
	}
	const actor = await authenticateBearer(request, {
		path: new URL(request.url).pathname,
		channel: "mcp",
	});
	if (actor instanceof Response) return actor;
	const server = createMcpServer(actor, request, routes);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(request);
	} finally {
		await server.close();
	}
}
