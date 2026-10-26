import { createFileRoute } from "@tanstack/react-router";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { readTemplateLogo } from "#/features/templates/templates.server.ts";

/** Template logo (SVG from the local templates directory). */
export const Route = createFileRoute("/api/templates/$templateId/logo")({
	server: {
		middleware: [requirePermission("app.view")],
		handlers: {
			GET: async ({ params }) => {
				const logo = await readTemplateLogo(params.templateId);
				if (!logo) return new Response("Not found", { status: 404 });
				return new Response(new Uint8Array(logo), {
					headers: {
						"Content-Type": "image/svg+xml",
						// SVG can carry script: never run it.
						"Content-Security-Policy":
							"default-src 'none'; style-src 'unsafe-inline'; sandbox",
						"X-Content-Type-Options": "nosniff",
						"Cache-Control": "private, max-age=3600",
					},
				});
			},
		},
	},
});
