import { createFileRoute } from "@tanstack/react-router";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { serverMetricsResponse } from "#/features/monitoring/metrics-http.server.ts";
import { i18nMiddleware } from "#/libs/i18n";

/** Live metrics of a server (SSE: `snapshot`, then one `tick` per collection). */
export const Route = createFileRoute("/api/servers/$serverId/metrics")({
	server: {
		middleware: [i18nMiddleware, requirePermission("monitoring.view")],
		handlers: {
			GET: ({ params, request, context }) =>
				serverMetricsResponse(context.actor, params.serverId, request),
		},
	},
});
