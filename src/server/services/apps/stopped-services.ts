import type { ServiceAction } from "./commands";

/**
 * Services the owner stopped one by one (app inputs `stoppedServices`)
 * after a successful service action: a stop adds the service, a start or
 * restart removes it, and an action on the whole app (or a deploy, which
 * starts everything) clears the list. Stopped services are expected to be
 * down: no `container_exited` alert, not "partially running".
 */
export function nextStoppedServices(
	current: readonly string[] | undefined,
	action: ServiceAction,
	service?: string,
): string[] | undefined {
	if (!service) return undefined;
	const rest = (current ?? []).filter((name) => name !== service);
	const next = action === "stop" ? [...rest, service] : rest;
	return next.length > 0 ? next : undefined;
}
