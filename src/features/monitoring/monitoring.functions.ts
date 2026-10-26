import { createServerFn } from "@tanstack/react-start";
import { getAppRow } from "#/features/apps/apps.server.ts";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { getServer } from "#/features/servers/servers.server.ts";
import { AppError } from "#/utils/error.ts";
import { appHistory, listAlerts, serverHistory } from "./monitoring.server";
import {
	AlertListInputSchema,
	AppHistoryInputSchema,
	ServerHistoryInputSchema,
} from "./schema";

export const getServerHistoryFn = createServerFn({ method: "GET" })
	.validator((data) => ServerHistoryInputSchema.parse(data))
	.middleware([requirePermission("monitoring.view")])
	.handler(async ({ context, data }) => {
		const server = await getServer(context.actor, data.serverId);
		if (!server) throw new AppError("SERVER_NOT_FOUND");
		return serverHistory(server.id, data.range);
	});

export const getAppHistoryFn = createServerFn({ method: "GET" })
	.validator((data) => AppHistoryInputSchema.parse(data))
	.middleware([requirePermission("monitoring.view")])
	.handler(async ({ context, data }) => {
		const app = await getAppRow(context.actor, data.appId);
		return appHistory(app.id, data.range);
	});

/** Alerts of the user's servers/apps (owner filter is always applied). */
export const listAlertsFn = createServerFn({ method: "GET" })
	.validator((data) => AlertListInputSchema.parse(data ?? {}))
	.middleware([requirePermission("monitoring.view")])
	.handler(async ({ context, data }) => listAlerts(context.actor, data));
