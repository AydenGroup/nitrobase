import { createFileRoute } from "@tanstack/react-router";
import script from "../../../scripts/install.sh?raw";

/**
 * The one-line installer (scripts/install.sh) served by any Nitrobase, so a
 * new VPS can be set up from an existing panel:
 *   curl -fsSL https://<panel>/api/install.sh | sudo bash -s -- --help
 */
export const Route = createFileRoute("/api/install.sh")({
	server: {
		handlers: {
			GET: async () =>
				new Response(script, {
					headers: {
						"Content-Type": "text/x-shellscript; charset=utf-8",
						"X-Content-Type-Options": "nosniff",
						"Cache-Control": "no-cache",
					},
				}),
		},
	},
});
