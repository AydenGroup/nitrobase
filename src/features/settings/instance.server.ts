import { eq } from "drizzle-orm";
import { jobTitle } from "#/config/job-titles.ts";
import { getConfig, hostPaths } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { servers } from "#/db/schema/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess, systemActor } from "#/features/auth/access.ts";
import { startJob } from "#/features/deployments/deployments.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import {
	connectNetworkCommand,
	ensureNetworkCommand,
	removeFileCommand,
} from "#/server/services/apps/commands.ts";
import { audit } from "#/server/services/audit.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { isInContainer } from "#/server/services/local.ts";
import { assertServerOwned } from "#/server/services/server-setup.ts";
import { generateTraefikDynamic } from "#/server/services/templates/traefik-dynamic.ts";
import { AppError, commandError } from "#/utils/error.ts";
import { getSetting, listSettings } from "./settings.server";

const PANEL_KEY = "panel";

/**
 * Env the operator sets once the panel route works: APP_URL on the
 * domain, the panel bound to loopback (Traefik reaches it on PANEL_PORT).
 */
export function panelEnvHints(domain: string): {
	appUrl: string;
	bind: string;
} {
	return {
		appUrl: `APP_URL=https://${domain}`,
		bind: `PANEL_BIND=127.0.0.1:${getConfig().PANEL_PORT}`,
	};
}

export function panelRoutePath(): string {
	return `${hostPaths().traefikDynamic}/app-${PANEL_KEY}.yml`;
}

/**
 * Route the panel domain (Settings → Instance) through Traefik on the
 * Localhost server: attach the Nitrobase container to the proxy network and
 * write `app-panel.yml`. Clearing the setting removes the route.
 */
export async function applyPanelDomain(
	actor: Actor,
): Promise<{ deploymentId: string }> {
	const [server] = await db
		.select()
		.from(servers)
		.where(eq(servers.isDefault, true))
		.limit(1);
	// Instance-wide: the local server may belong to another team than the
	// admin's active one; the job is recorded in the server's team.
	assertCanAccess(actor, "instance.manage");
	if (!server) throw new AppError("SERVER_NOT_FOUND");
	if (server.status !== "ready") throw new AppError("SERVER_NOT_READY");
	if (!isInContainer()) throw new AppError("PANEL_NOT_CONTAINERIZED");
	const domain = await getSetting("instance.panelDomain");
	const config = getConfig();
	audit({
		actor,
		action: "settings.panel_route",
		meta: { domain: domain ?? null },
	});

	return startJob(
		{
			actor: { teamId: server.teamId, userId: actor.userId },
			serverId: server.id,
			type: "panel_route",
			title: jobTitle("panel_route"),
		},
		async (ctx) => {
			const executor = await getExecutor(server);
			try {
				// The route file lives under the managed root.
				await assertServerOwned(executor, await requireInstanceId());
				if (!domain) {
					await executor.exec(removeFileCommand(panelRoutePath()));
					ctx.event("panel.route_removed");
					return { success: true };
				}
				// The panel gets its own network shared only with Traefik, so app
				// containers on the proxy network can't reach it directly.
				ctx.event("panel.connecting", { network: config.PANEL_NETWORK });
				const panel = config.PANEL_CONTAINER;
				for (const command of [
					ensureNetworkCommand(config.PANEL_NETWORK),
					connectNetworkCommand(config.PANEL_NETWORK, config.TRAEFIK_CONTAINER),
					connectNetworkCommand(config.PANEL_NETWORK, panel),
				]) {
					const result = await executor.exec(command);
					if (result.exitCode !== 0) {
						throw commandError("PANEL_NETWORK_FAILED", result.stderr);
					}
				}
				const yaml = generateTraefikDynamic({
					appKey: PANEL_KEY,
					routes: [
						{
							host: domain,
							service: "panel",
							port: config.PANEL_PORT,
							https: true,
						},
					],
					containerNames: { panel },
					certResolver: config.TRAEFIK_CERT_RESOLVER,
				});
				await executor.upload(yaml, panelRoutePath(), "0644");
				ctx.event("panel.routed", { url: `https://${domain}` });
				ctx.event("panel.env_hint", panelEnvHints(domain));
				return { success: true };
			} catch (error) {
				return { success: false, error };
			} finally {
				executor.close();
			}
		},
	);
}

async function defaultServer() {
	const [server] = await db
		.select()
		.from(servers)
		.where(eq(servers.isDefault, true))
		.limit(1);
	return server ?? null;
}

/**
 * Re-attach the panel container to PANEL_NETWORK when a panel route
 * exists. A recreated container (upgrade, `docker compose up` after a
 * PANEL_BIND change) loses that attachment, and Traefik could no longer
 * reach the panel. Idempotent; run at boot and after an upgrade.
 */
export async function ensurePanelAttached(): Promise<void> {
	if (!isInContainer()) return;
	if (!(await getSetting("instance.panelDomain"))) return;
	const server = await defaultServer();
	if (!server || server.status !== "ready") return;
	const config = getConfig();
	const executor = await getExecutor(server);
	try {
		const routed = await executor.exec(`test -f ${q(panelRoutePath())}`);
		if (routed.exitCode !== 0) return;
		const panel = config.PANEL_CONTAINER;
		for (const command of [
			ensureNetworkCommand(config.PANEL_NETWORK),
			connectNetworkCommand(config.PANEL_NETWORK, panel),
		]) {
			const result = await executor.exec(command);
			if (result.exitCode !== 0) {
				throw commandError("PANEL_NETWORK_FAILED", result.stderr);
			}
		}
	} finally {
		executor.close();
	}
}

/**
 * Installer `--domain`: the panel domain comes from PANEL_DOMAIN (the
 * setting's env fallback). Once Localhost is bootstrapped (Traefik runs),
 * the route is applied without a click; a route already written is kept.
 */
export async function applyPanelDomainFromEnv(): Promise<void> {
	if (!isInContainer() || !process.env.PANEL_DOMAIN?.trim()) return;
	const view = (await listSettings()).find(
		(item) => item.key === "instance.panelDomain",
	);
	if (!view?.fromEnv) return;
	const server = await defaultServer();
	if (!server || server.status !== "ready") return;
	const executor = await getExecutor(server);
	try {
		const routed = await executor.exec(`test -f ${q(panelRoutePath())}`);
		if (routed.exitCode === 0) return;
	} finally {
		executor.close();
	}
	const actor = systemActor(server.teamId, server.userId, { instance: true });
	// Right after a bootstrap the server's lock is still held for a moment.
	const config = getConfig();
	for (let attempt = 0; attempt < config.PANEL_ROUTE_RETRIES; attempt++) {
		try {
			await applyPanelDomain(actor);
			return;
		} catch (error) {
			if (!(error instanceof AppError) || error.code !== "SERVER_BUSY") {
				throw error;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, config.PANEL_ROUTE_RETRY_MS),
			);
		}
	}
}
