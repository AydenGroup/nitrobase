import type { ContainerSample } from "./types";

/** Delay before the next tick: the interval, doubled per failure, capped. */
export function nextDelay(
	failures: number,
	intervalMs: number,
	maxMs: number,
): number {
	if (failures <= 0) return intervalMs;
	return Math.min(maxMs, intervalMs * 2 ** Math.min(failures, 16));
}

/**
 * Map `nitrobase.app` labels to apps of this server only (no spoofing), and
 * only for containers of that app's compose project (its folder): a
 * stray container carrying the label is not attributed to the app.
 */
export function mapContainerApps(
	containers: ContainerSample[],
	apps: ReadonlyMap<string, string>,
): ContainerSample[] {
	return containers.map((container) => {
		const folder = container.appLabel
			? apps.get(container.appLabel)
			: undefined;
		return {
			...container,
			appId:
				folder !== undefined && container.project === folder
					? container.appLabel
					: null,
		};
	});
}
