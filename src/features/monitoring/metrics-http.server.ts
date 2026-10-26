import { z } from "zod";
import { getAppRow } from "#/features/apps/apps.server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { APP_STREAM_UNREACHABLE } from "#/features/monitoring/schema.ts";
import { monitoringStream } from "#/features/monitoring/stream.server.ts";
import { getServer } from "#/features/servers/servers.server.ts";
import { AppError } from "#/utils/error.ts";

/**
 * HTTP handler bodies of the live metrics streams (SSE: `snapshot`, then
 * one `tick` per collection).
 */

/** Live metrics of a server. */
export async function serverMetricsResponse(
	actor: Actor,
	serverIdParam: string,
	request: Request,
): Promise<Response> {
	const id = z.guid().safeParse(serverIdParam);
	if (!id.success) {
		return Response.json({ message: "Bad request" }, { status: 400 });
	}
	const server = await getServer(actor, id.data);
	if (!server) {
		return Response.json({ message: "Server not found" }, { status: 404 });
	}
	return monitoringStream({
		actor,
		serverId: server.id,
		signal: request.signal,
	});
}

/**
 * Live container metrics of one app. Ticks of the app's server are
 * narrowed to the app's containers; server-wide data is never sent.
 */
export async function appMetricsResponse(
	actor: Actor,
	appIdParam: string,
	request: Request,
): Promise<Response> {
	const id = z.guid().safeParse(appIdParam);
	if (!id.success) {
		return Response.json({ message: "Bad request" }, { status: 400 });
	}
	let app: Awaited<ReturnType<typeof getAppRow>>;
	try {
		app = await getAppRow(actor, id.data);
	} catch (error) {
		if (error instanceof AppError) {
			return Response.json({ message: "App not found" }, { status: 404 });
		}
		throw error;
	}
	return monitoringStream({
		actor,
		serverId: app.serverId,
		signal: request.signal,
		// Server data and raw collection errors (SSH text, host) stay on the
		// server view; the app view gets a translatable code.
		filter: (tick) => ({
			...tick,
			error: undefined,
			problem: tick.ok ? undefined : APP_STREAM_UNREACHABLE,
			server: null,
			containers:
				tick.containers?.filter((container) => container.appId === app.id) ??
				null,
		}),
	});
}
