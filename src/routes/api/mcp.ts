import { createFileRoute } from "@tanstack/react-router";
import { handleMcpRequest } from "#/server/api/mcp.ts";

/** `/api/mcp`: the MCP server for AI agents (see #/server/api/mcp.ts). */
export const Route = createFileRoute("/api/mcp")({
	server: {
		handlers: {
			GET: ({ request }) => handleMcpRequest(request),
			POST: ({ request }) => handleMcpRequest(request),
			DELETE: ({ request }) => handleMcpRequest(request),
		},
	},
});
