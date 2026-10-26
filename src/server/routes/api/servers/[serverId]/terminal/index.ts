import { serverTerminalTarget } from "#/features/servers/terminal.server.ts";
import { createTerminalHandler } from "#/server/terminal/handler.ts";

/** Host shell on a managed server. */
export default createTerminalHandler({
	pathPattern: /^\/api\/servers\/([0-9a-f-]{36})\/terminal$/,
	permission: "server.terminal",
	resolve: (actor, match) => serverTerminalTarget(actor, match[1]),
});
