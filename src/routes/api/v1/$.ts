import { createFileRoute } from "@tanstack/react-router";
import { handleApiRequest } from "#/server/api/v1-handler.ts";

/** `/api/v1/*`: the bearer-token REST surface (see #/server/api/v1-handler.ts). */
export const Route = createFileRoute("/api/v1/$")({
	server: {
		handlers: {
			GET: ({ request, params }) =>
				handleApiRequest(request, params._splat ?? ""),
			POST: ({ request, params }) =>
				handleApiRequest(request, params._splat ?? ""),
		},
	},
});
