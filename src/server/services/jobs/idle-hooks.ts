/**
 * Listeners called after a server's job lock is released. Used to run
 * follow-up work that had to wait (e.g. pending route updates). Errors are
 * logged, never thrown into the job runner.
 */
export type IdleListener = (serverId: string) => Promise<void> | void;

export function createIdleHooks() {
	const listeners = new Set<IdleListener>();
	return {
		on(listener: IdleListener): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async notify(serverId: string): Promise<void> {
			for (const listener of [...listeners]) {
				try {
					await listener(serverId);
				} catch (error) {
					console.error("[jobs] idle listener failed", error);
				}
			}
		},
	};
}

export interface PendingRoutesDeps {
	/** Apps on the server with `routesPending` set (oldest first). */
	listPending(serverId: string): Promise<{ appId: string; teamId: string }[]>;
	/** Start a routes job; throws when the server is busy again. */
	startRoutes(appId: string, teamId: string): Promise<unknown>;
	/** appId -> time of the last automatic attempt (shared, survives HMR). */
	attempts: Map<string, number>;
	/** Minimum time between automatic attempts for the same app. */
	backoffMs: number;
	now?: () => number;
}

/**
 * Idle listener that starts one routes job for the oldest app with pending
 * routes. That job releasing the lock triggers the next one, so pending
 * apps drain one after another. Each app is retried automatically at most
 * once per `backoffMs`: a routes job that fails (or leaves the flag set)
 * can never loop; the UI keeps offering "Apply routes" for it.
 */
export function pendingRoutesListener(deps: PendingRoutesDeps): IdleListener {
	const now = deps.now ?? Date.now;
	return async (serverId) => {
		const pending = await deps.listPending(serverId);
		const next = pending.find((item) => {
			const last = deps.attempts.get(item.appId);
			return last === undefined || now() - last >= deps.backoffMs;
		});
		if (!next) return;
		deps.attempts.set(next.appId, now());
		try {
			await deps.startRoutes(next.appId, next.teamId);
		} catch {
			// Busy again: the job holding the lock notifies us on release.
			deps.attempts.delete(next.appId);
		}
	};
}
