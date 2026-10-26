import type { Actor } from "#/features/auth/access.ts";
import { getServerRow } from "#/features/servers/servers.server.ts";
import type { TerminalTarget } from "#/server/terminal/handler.ts";

/**
 * Host shell on a managed server (team and permission checked). A coded
 * error: the terminal shows it in the reader's language.
 */
export async function serverTerminalTarget(
	actor: Actor,
	serverId: string,
): Promise<TerminalTarget> {
	const server = await getServerRow(actor, serverId, "server.terminal");
	return {
		server,
		auditAction: "server.terminal.open",
		auditCloseAction: "server.terminal.close",
		auditTarget: { type: "server", id: server.id },
		greeting: (i18n) => i18n._("Connecting to terminal..."),
	};
}
