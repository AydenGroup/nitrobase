import { createFileRoute } from "@tanstack/react-router";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { backupDownloadResponse } from "#/features/backups/download.server.ts";
import { i18nMiddleware } from "#/libs/i18n";

/**
 * Download a backup archive: streamed from the destination through the
 * server that can reach it, never stored on the panel. Needs
 * backup.download (and instance.manage for panel backups); audited.
 */
export const Route = createFileRoute("/api/backups/$backupId/download")({
	server: {
		middleware: [i18nMiddleware, requirePermission("backup.download")],
		handlers: {
			GET: ({ params, context, request }) =>
				backupDownloadResponse(context.actor, params.backupId, request),
		},
	},
});
