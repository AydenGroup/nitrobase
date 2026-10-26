import { createFileRoute } from "@tanstack/react-router";
import { auditExportResponse } from "#/features/audit/audit.server.ts";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n";

/** CSV export of the audit log with the page's filters. */
export const Route = createFileRoute("/api/audit/export")({
	server: {
		middleware: [i18nMiddleware, requirePermission("team.view")],
		handlers: {
			GET: ({ request, context }) =>
				auditExportResponse(context.actor, request),
		},
	},
});
