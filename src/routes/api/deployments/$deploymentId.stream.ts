import { createFileRoute } from "@tanstack/react-router";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { panelDeploymentStreamResponse } from "#/features/deployments/stream.server.ts";
import { i18nMiddleware } from "#/libs/i18n";

/**
 * Read-only SSE log stream for a deployment: replays stored lines, then
 * tails live ones until the job completes. Supports Last-Event-ID resume.
 */
export const Route = createFileRoute("/api/deployments/$deploymentId/stream")({
	server: {
		middleware: [i18nMiddleware, requirePermission("server.view")],
		handlers: {
			GET: ({ params, request, context }) =>
				panelDeploymentStreamResponse(
					context.actor,
					params.deploymentId,
					request,
				),
		},
	},
});
