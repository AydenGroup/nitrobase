import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n.ts";
import { APP_FOLDER_PATTERN } from "#/libs/naming-rules.ts";
import { getAcmeEmail } from "#/server/services/acme.ts";
import { listOrphans, wipeOrphan } from "./orphans.server";
import {
	AddServerSchema,
	ServerResourcePolicySchema,
	ServerTunnelSchema,
	StartServerActionSchema,
	TestServerCredentialsSchema,
	UpdateServerSchema,
} from "./schema";
import {
	createServer,
	deleteServer,
	getServer,
	listServerSummaries,
	listServers,
	previewBootstrap,
	resetHostKey,
	startServerAction,
	testServerCredentials,
	updateServer,
	updateServerResourcePolicy,
} from "./servers.server";
import { getTunnelStatus, updateServerTunnel } from "./tunnel.server";

// Server RPCs. Each is gated by a permission and passes `context.actor`
// down, so every query is scoped to the caller's own servers.

export const listServersFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("server.view")])
	.handler(async ({ context }) => {
		return listServers(context.actor);
	});

export const listServerSummariesFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("server.view")])
	.handler(async ({ context }) => listServerSummaries(context.actor));

export const getServerFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("server.view")])
	.validator((serverId: string) => serverId)
	.handler(async ({ context, data }) => {
		// Malformed ids are "not found", not a database error.
		if (!z.guid().safeParse(data).success) return null;
		return getServer(context.actor, data);
	});

/** Input is parsed in the handler so Zod messages use the request locale. */
export const addServerFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("server.manage")])
	.handler(async ({ data, context }) => {
		const parsed = AddServerSchema(context.i18n).parse(data);
		return createServer(context.actor, parsed);
	});

export const updateServerFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("server.manage")])
	.handler(async ({ data, context }) => {
		const parsed = UpdateServerSchema(context.i18n).parse(data);
		const { id, ...updateData } = parsed;
		return updateServer(context.actor, id, updateData);
	});

/** Refused for the default server, busy servers and servers with apps. */
export const deleteServerFn = createServerFn({ method: "POST" })
	.validator((serverId: string) => z.guid().parse(serverId))
	.middleware([requirePermission("server.manage")])
	.handler(async ({ context, data }) => {
		await deleteServer(context.actor, data);
		return { success: true };
	});

export const testServerCredentialsFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("server.manage")])
	.handler(async ({ data, context }) => {
		const parsed = TestServerCredentialsSchema.parse(data);
		return testServerCredentials(context.actor, parsed);
	});

/**
 * Start bootstrap / connection test as a background job (POST + CSRF
 * protected). Stream progress from /api/deployments/$deploymentId/stream.
 */
export const startServerActionFn = createServerFn({ method: "POST" })
	.validator((data) => StartServerActionSchema.parse(data))
	.middleware([requirePermission("server.manage")])
	.handler(async ({ context, data }) => {
		return startServerAction(
			context.actor,
			data.serverId,
			data.action,
			data.action === "bootstrap" ? getAcmeEmail(context.user.email) : "",
			{ takeover: data.takeover },
		);
	});

/** What a bootstrap would change (probes the server; confirmation dialog). */
export const previewBootstrapFn = createServerFn({ method: "POST" })
	.validator((serverId: string) => z.guid().parse(serverId))
	.middleware([requirePermission("server.manage")])
	.handler(async ({ context, data }) => previewBootstrap(context.actor, data));

export const resetHostKeyFn = createServerFn({ method: "POST" })
	.validator((serverId: string) => z.guid().parse(serverId))
	.middleware([requirePermission("server.manage")])
	.handler(async ({ context, data }) => {
		return resetHostKey(context.actor, data);
	});

export const listOrphansFn = createServerFn({ method: "GET" })
	.validator((serverId: string) => z.guid().parse(serverId))
	.middleware([requirePermission("server.manage")])
	.handler(async ({ context, data }) => listOrphans(context.actor, data));

export const wipeOrphanFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({
				serverId: z.guid(),
				folder: z.string().regex(APP_FOLDER_PATTERN),
				confirmName: z.string(),
				forceUnknown: z.boolean().optional(),
			})
			.parse(data),
	)
	.middleware([requirePermission("server.manage")])
	.handler(async ({ context, data }) =>
		wipeOrphan(
			context.actor,
			data.serverId,
			data.folder,
			data.confirmName,
			data.forceUnknown,
		),
	);

/** Save the Cloudflare Tunnel settings and converge cloudflared (job). */
export const updateServerTunnelFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => ServerTunnelSchema.parse(data))
	.middleware([requirePermission("server.manage")])
	.handler(async ({ context, data }) =>
		updateServerTunnel(context.actor, data, getAcmeEmail(context.user.email)),
	);

/** Connector state: connected / connecting / failing / stopped. */
export const getTunnelStatusFn = createServerFn({ method: "GET" })
	.validator((serverId: string) => z.guid().parse(serverId))
	.middleware([requirePermission("server.view")])
	.handler(async ({ context, data }) => getTunnelStatus(context.actor, data));

/** Require limits on every app service / default memory limit (M6). */
export const updateServerResourcePolicyFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => ServerResourcePolicySchema.parse(data))
	.middleware([requirePermission("server.manage")])
	.handler(async ({ context, data }) =>
		updateServerResourcePolicy(context.actor, data),
	);
