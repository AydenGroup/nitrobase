import { createFileRoute } from "@tanstack/react-router";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { appMetricsResponse } from "#/features/monitoring/metrics-http.server.ts";
import { i18nMiddleware } from "#/libs/i18n";

/** Live container metrics of one app (SSE, the app's containers only). */
export const Route = createFileRoute("/api/apps/$appId/metrics")({
	server: {
		middleware: [i18nMiddleware, requirePermission("monitoring.view")],
		handlers: {
			GET: ({ params, request, context }) =>
				appMetricsResponse(context.actor, params.appId, request),
		},
	},
});
