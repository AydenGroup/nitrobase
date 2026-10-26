import { createFileRoute } from "@tanstack/react-router";
import { appLogsResponse } from "#/features/apps/logs.server.ts";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n";

/**
 * Container logs for an app: `GET ?service=&tail=` streams
 * `docker compose logs -f` as SSE; `&download=1` returns the last `tail`
 * lines as a text file.
 */
export const Route = createFileRoute("/api/apps/$appId/logs")({
	server: {
		middleware: [i18nMiddleware, requirePermission("app.view")],
		handlers: {
			GET: ({ params, request, context }) =>
				appLogsResponse(
					context.actor,
					context.user.userId,
					params.appId,
					request,
				),
		},
	},
});
