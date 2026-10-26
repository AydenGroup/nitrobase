import {
	containerName,
	deployedServices,
	getAppRow,
	getAppServer,
} from "#/features/apps/apps.server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { containerShellCommand } from "#/server/services/apps/commands.ts";
import { hasLocalPty } from "#/server/services/local.ts";
import type { TerminalTarget } from "#/server/terminal/handler.ts";
import { AppError } from "#/utils/error.ts";

/**
 * Shell inside one of an app's service containers (team and permission
 * checked). Coded errors: the terminal shows them in the reader's language.
 */
export async function appTerminalTarget(
	actor: Actor,
	appId: string,
	service: string,
): Promise<TerminalTarget> {
	const app = await getAppRow(actor, appId, "app.terminal");
	if (!deployedServices(app).includes(service)) {
		throw new AppError("APP_SERVICE_NOT_FOUND", { service });
	}
	const server = await getAppServer(app);
	// A PTY is available over SSH and from `script` on Linux (in the panel
	// container or not); the macOS dev fallback has none.
	const tty = !server.isDefault || hasLocalPty();
	return {
		server,
		appId: app.id,
		command: containerShellCommand(
			containerName(app.folder, service),
			tty,
			app.id,
		),
		auditAction: "app.terminal.open",
		auditCloseAction: "app.terminal.close",
		auditTarget: { type: "app", id: app.id },
		greeting: (i18n) => i18n._("Connecting to {service}...", { service }),
	};
}
