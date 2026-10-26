import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** Deploy pre-flight checks (ids produced by preflight.server.ts). */
export type PreflightCheckId =
	| "server"
	| "docker"
	| "traefik"
	| "memory"
	| "disk"
	| "limits"
	| "owner"
	| "domain"
	| "template";

/** Labels for deploy pre-flight checks. */
export const preflightLabels = {
	server: msg({ id: "Server bootstrapped" }),
	docker: msg({ id: "Docker running" }),
	traefik: msg({ id: "Traefik running" }),
	memory: msg({ id: "Free memory" }),
	disk: msg({ id: "Free disk space" }),
	limits: msg({ id: "Resource limits" }),
	owner: msg({ id: "Managed by this panel" }),
	domain: msg({ id: "Domain" }),
	template: msg({ id: "Template renders" }),
} satisfies Record<PreflightCheckId, MessageDescriptor>;
