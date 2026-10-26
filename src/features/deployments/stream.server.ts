import { z } from "zod";
import type { Permission } from "#/config/permissions.ts";
import type { Actor } from "#/features/auth/access.ts";
import {
	liveConnectionOf,
	liveSessionSignal,
} from "#/features/auth/sessions.server.ts";
import { streamDeployment } from "#/features/deployments/deployments.server.ts";
import { getDeployment } from "#/features/servers/servers.server.ts";
import { parseLastEventId } from "#/libs/job-log.ts";
import { sseResponse } from "#/server/services/sse.ts";
import { AppError } from "#/utils/error.ts";

/**
 * A job's log as an event stream (access checked by the caller): stored
 * lines after Last-Event-ID / `?after=`, then live ones until it ends. It
 * closes when the client goes away or the session/token is revoked.
 */
export function deploymentStreamResponse(
	actor: Actor,
	deploymentId: string,
	request: Request,
	options: {
		permission: Permission;
		/** Panel UI frames (`{ line, code, params }`); else text lines (REST API). */
		coded: boolean;
	},
): Response {
	const url = new URL(request.url);
	const afterSeq = parseLastEventId(
		request.headers.get("last-event-id") ?? url.searchParams.get("after"),
	);
	const live = liveSessionSignal(
		liveConnectionOf(actor, options.permission),
		request.signal,
	);
	return sseResponse(
		streamDeployment(deploymentId, afterSeq, live.signal, live.release, {
			coded: options.coded,
		}),
	);
}

/** HTTP handler body of the panel's `/api/deployments/$deploymentId/stream`. */
export async function panelDeploymentStreamResponse(
	actor: Actor,
	deploymentIdParam: string,
	request: Request,
): Promise<Response> {
	const id = z.guid().safeParse(deploymentIdParam);
	if (!id.success) {
		return Response.json({ message: "Bad request" }, { status: 400 });
	}
	try {
		await getDeployment(actor, id.data);
	} catch (error) {
		if (error instanceof AppError) {
			return Response.json(
				{ message: "Deployment not found" },
				{ status: 404 },
			);
		}
		throw error;
	}
	return deploymentStreamResponse(actor, id.data, request, {
		permission: "server.view",
		coded: true,
	});
}
