import { createFileRoute } from "@tanstack/react-router";
import { healthResponse } from "#/features/health/health.server.ts";

/** Liveness of the panel and its database (container health check). */
export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: () => healthResponse(),
		},
	},
});
