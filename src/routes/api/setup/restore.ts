import { createFileRoute } from "@tanstack/react-router";
import { firstRunRestoreResponse } from "#/features/setup/restore-http.server.ts";
import { i18nMiddleware } from "#/libs/i18n";

/** First-run restore of the panel from a self-backup (see the handler). */
export const Route = createFileRoute("/api/setup/restore")({
	server: {
		middleware: [i18nMiddleware],
		handlers: {
			POST: ({ request, context }) =>
				firstRunRestoreResponse(request, context.i18n),
		},
	},
});
