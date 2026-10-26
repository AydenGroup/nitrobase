import { appTerminalTarget } from "#/features/apps/terminal.server.ts";
import { createTerminalHandler } from "#/server/terminal/handler.ts";

/** Shell inside an app's service container: `?service=<name>`. */
export default createTerminalHandler({
	pathPattern: /^\/api\/apps\/([0-9a-f-]{36})\/terminal$/,
	permission: "app.terminal",
	resolve: (actor, match, url) =>
		appTerminalTarget(actor, match[1], url.searchParams.get("service") ?? ""),
});
