import { eq } from "drizzle-orm";
import { jobTitle } from "#/config/job-titles.ts";
import { getConfig, hostPaths } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { servers } from "#/db/schema/server.ts";
import {
	registerPendingRoutes,
	resetPendingRoutesBackoff,
} from "#/features/apps/domains.server.ts";
import type { Actor } from "#/features/auth/access.ts";
import type { JobLogger } from "#/features/deployments/deployments.server.ts";
import {
	type JobContext,
	type JobOutcome,
	startJob,
} from "#/features/deployments/deployments.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import { audit } from "#/server/services/audit.ts";
import type { Executor } from "#/server/services/executor.ts";
import {
	assertServerUsable,
	probeServerOwnership,
	setupTraefik,
} from "#/server/services/server-setup.ts";
import {
	isTunnelToken,
	parseTunnelStatus,
	type TunnelSettings,
	type TunnelState,
	tunnelConfigHash,
	tunnelDownScript,
	tunnelEnvFile,
	tunnelStatusScript,
	tunnelUpScript,
} from "#/server/services/tunnel.ts";
import { decrypt, encrypt } from "#/utils/crypto.ts";
import { AppError, commandError } from "#/utils/error.ts";
import type { ServerRow } from "./schema";
import { getExecutor, getServerRow } from "./servers.server";

/**
 * Cloudflare Tunnel per server (token-based; the tunnel and its public
 * hostnames are created in the Cloudflare dashboard, pointing at
 * `tunnelServiceUrl()`, Traefik's unpublished tunnel entrypoint). Nitrobase stores the connector token
 * encrypted, runs `cloudflared` on nitrobase-network, and routes "via
 * tunnel" domains on Traefik's plain HTTP entrypoint.
 */

function tunnelSettings(config = getConfig()): TunnelSettings {
	return {
		container: config.CLOUDFLARED_CONTAINER,
		image: config.CLOUDFLARED_IMAGE,
		// Only the private tunnel network: cloudflared never sees app containers.
		network: config.TUNNEL_NETWORK,
		envFile: hostPaths(config).tunnelEnv,
		metricsPort: config.CLOUDFLARED_METRICS_PORT,
	};
}

/** Service URL each tunnel public hostname points at (Cloudflare dashboard). */
export function tunnelServiceUrl(config = getConfig()): string {
	return `http://${config.TRAEFIK_CONTAINER}:${config.TRAEFIK_TUNNEL_PORT}`;
}

export interface TunnelInput {
	serverId: string;
	/** New token; empty keeps the stored one. */
	token?: string;
	enabled: boolean;
	tunnelOnly: boolean;
}

/** Save the tunnel settings and converge the server (job). */
export async function updateServerTunnel(
	actor: Actor,
	input: TunnelInput,
	acmeEmail: string,
): Promise<{ deploymentId: string | null }> {
	const server = await getServerRow(actor, input.serverId, "server.manage");
	const token = input.token?.trim();
	if (token && !isTunnelToken(token))
		throw new AppError("TUNNEL_TOKEN_INVALID");
	if (input.enabled && !token && !server.tunnelTokenEncrypted) {
		throw new AppError("TUNNEL_TOKEN_INVALID");
	}
	if (input.tunnelOnly && !input.enabled) {
		throw new AppError("TUNNEL_NOT_CONFIGURED");
	}
	const [updated] = await db
		.update(servers)
		.set({
			...(token && { tunnelTokenEncrypted: encrypt(token) }),
			tunnelEnabled: input.enabled,
			tunnelOnly: input.tunnelOnly,
			updatedAt: new Date(),
		})
		.where(eq(servers.id, server.id))
		.returning();
	audit({
		actor,
		action: "server.tunnel.update",
		targetType: "server",
		targetId: server.id,
		meta: {
			enabled: input.enabled,
			tunnelOnly: input.tunnelOnly,
			tokenChanged: !!token,
		},
	});
	// Not bootstrapped yet: bootstrap applies the settings (and needs no
	// free 80/443 on a tunnel-only server).
	if (server.status !== "ready") return { deploymentId: null };
	const proxyChanged = server.tunnelOnly !== updated.tunnelOnly;
	// "Via tunnel" domains switch between tunnel and direct routing.
	// Rewritten whenever the tunnel is on too: applying converges routes
	// (e.g. after an upgrade that moved tunnel hosts to their entrypoint).
	const routesChanged =
		proxyChanged ||
		server.tunnelEnabled !== updated.tunnelEnabled ||
		updated.tunnelEnabled;
	return startJob(
		{
			actor,
			serverId: server.id,
			type: "tunnel",
			title: jobTitle("tunnel", { server: server.name }),
		},
		(ctx) =>
			runTunnel(updated, { proxyChanged, routesChanged, acmeEmail }, ctx),
	);
}

async function runTunnel(
	server: ServerRow,
	options: { proxyChanged: boolean; routesChanged: boolean; acmeEmail: string },
	ctx: JobContext,
): Promise<JobOutcome> {
	let executor: Executor | null = null;
	try {
		executor = await getExecutor(server);
		const instanceId = await requireInstanceId();
		assertServerUsable(await probeServerOwnership(executor, instanceId));
		// Traefik first: it creates the private tunnel network (servers
		// bootstrapped before it existed) that cloudflared joins.
		// Converge Traefik too: its static config carries the unpublished
		// tunnel entrypoint (older bootstraps lack it), and tunnel-only
		// changes its published ports. Recreated only when the config changed.
		if (options.proxyChanged || server.tunnelEnabled) {
			ctx.event(
				options.proxyChanged
					? server.tunnelOnly
						? "tunnel.traefik_private"
						: "tunnel.traefik_public"
					: "tunnel.traefik_check",
			);
			await (ctx.critical ?? ((_label, step) => step()))("traefik_swap", () =>
				setupTraefik(
					executor as Executor,
					options.acmeEmail,
					ctx,
					!server.tunnelOnly,
					instanceId,
				),
			);
		}
		await convergeTunnel(executor, server, ctx, ctx.signal);
		if (options.routesChanged) {
			// Routes of every app change entrypoint/TLS with the mode.
			const flagged = await db
				.update(apps)
				.set({ routesPending: true })
				.where(eq(apps.serverId, server.id))
				.returning({ id: apps.id });
			registerPendingRoutes();
			resetPendingRoutesBackoff(flagged.map((row) => row.id));
			ctx.event("tunnel.routes_next");
		}
		if (server.tunnelEnabled) {
			const status = await readTunnelStatus(executor, server);
			ctx.event("tunnel.status", { state: status.state });
		}
		ctx.event("tunnel.applied");
		return { success: true };
	} catch (error) {
		return { success: false, error };
	} finally {
		executor?.close();
	}
}

/**
 * Start (or keep) the cloudflared connector when the tunnel is on, remove
 * it otherwise. Also run at the end of a bootstrap.
 */
export async function convergeTunnel(
	executor: Executor,
	server: Pick<ServerRow, "tunnelEnabled" | "tunnelTokenEncrypted">,
	log: JobLogger,
	signal?: AbortSignal,
): Promise<void> {
	const settings = tunnelSettings();
	if (server.tunnelEnabled && server.tunnelTokenEncrypted) {
		const token = decrypt(server.tunnelTokenEncrypted);
		log.event("tunnel.writing_token");
		await executor.upload(tunnelEnvFile(token), settings.envFile, "0600");
		log.event("setup.traefik_starting", {
			container: settings.container,
			image: settings.image,
		});
		const up = await executor.exec(
			tunnelUpScript(settings, tunnelConfigHash(settings, token)),
			{ signal },
		);
		if (up.exitCode !== 0) {
			throw commandError("TUNNEL_START_FAILED", up.stderr.trim());
		}
		log.event(
			up.stdout.includes("unchanged") ? "tunnel.current" : "tunnel.started",
		);
		return;
	}
	const down = await executor.exec(tunnelDownScript(settings));
	if (down.exitCode !== 0) {
		throw commandError("TUNNEL_REMOVE_FAILED", down.stderr.trim());
	}
}

export interface TunnelStatus {
	state: TunnelState;
	restarts: number;
	/** What each public hostname must point at in Cloudflare. */
	service: string;
}

async function readTunnelStatus(
	executor: Executor,
	server: Pick<ServerRow, "tunnelEnabled">,
): Promise<TunnelStatus> {
	const service = tunnelServiceUrl();
	if (!server.tunnelEnabled) {
		return { state: "not_configured", restarts: 0, service };
	}
	const config = getConfig();
	const result = await executor.exec(
		tunnelStatusScript(tunnelSettings(config), config.APP_HEALTH_IMAGE),
		{ timeoutMs: config.TUNNEL_STATUS_TIMEOUT_MS },
	);
	return { ...parseTunnelStatus(result.stdout), service };
}

/** Connector state of a server (opens its own connection). */
export async function serverTunnelStatus(
	server: ServerRow,
): Promise<TunnelStatus> {
	if (!server.tunnelEnabled) {
		return {
			state: "not_configured",
			restarts: 0,
			service: tunnelServiceUrl(),
		};
	}
	const executor = await getExecutor(server);
	try {
		return await readTunnelStatus(executor, server);
	} finally {
		executor.close();
	}
}

export async function getTunnelStatus(
	actor: Actor,
	serverId: string,
): Promise<TunnelStatus> {
	const server = await getServerRow(actor, serverId);
	return serverTunnelStatus(server);
}
