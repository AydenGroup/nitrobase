/**
 * Job lock rules (pure, tested). Two kinds of locks share one set:
 * - the server lock (`<serverId>`): server-level jobs (bootstrap, deploy,
 *   backup…) and short `withServerLock` mutations;
 * - app locks (`app:<appId>`): scheduled task runs, so jobs of other apps
 *   on the same server keep running.
 * They block each other both ways (see each rule).
 */
export interface LockJob {
	serverId: string;
	appId: string | null;
	/** Holds an app lock only. */
	appScoped: boolean;
}

export interface LockState {
	serverLocks: ReadonlySet<string>;
	jobs: Iterable<LockJob>;
}

export function appLockKey(appId: string): string {
	return `app:${appId}`;
}

/** Some app-scoped job (task run) is running on the server. */
function hasAppLockOn(state: LockState, serverId: string): boolean {
	for (const job of state.jobs) {
		if (job.appScoped && job.serverId === serverId) return true;
	}
	return false;
}

/**
 * An app-scoped job may not start when its app already has one, or when
 * the server lock is held by: a mutation without a job (`withServerLock`),
 * a job about no app (bootstrap…) or a job about this app (deploy…).
 */
export function isAppBusy(
	state: LockState,
	serverId: string,
	appId: string,
): boolean {
	if (state.serverLocks.has(appLockKey(appId))) return true;
	if (!state.serverLocks.has(serverId)) return false;
	let holder = false;
	for (const job of state.jobs) {
		if (job.serverId !== serverId || job.appScoped) continue;
		holder = true;
		if (job.appId === null || job.appId === appId) return true;
	}
	// Server lock without a job: a `withServerLock` mutation.
	return !holder;
}

/**
 * A server-level job may not start when the server (or `alsoLock`) is
 * locked, when its own app has a task running, or, for a job about no
 * app (bootstrap, orphan wipe), when any task runs on the server.
 */
export function isServerJobBlocked(
	state: LockState,
	params: { serverId: string; appId?: string | null; alsoLock?: string[] },
): boolean {
	const servers = [params.serverId, ...(params.alsoLock ?? [])];
	if (servers.some((id) => state.serverLocks.has(id))) return true;
	if (params.appId) return state.serverLocks.has(appLockKey(params.appId));
	return servers.some((id) => hasAppLockOn(state, id));
}

/**
 * `withServerLock` mutations wait for the server's jobs. An app-scoped
 * mutation (an app's settings, resources, source, domains…) passes its
 * `appId` and only waits for that app's own app-scoped job (a build can
 * last 20 minutes: other apps' settings stay editable meanwhile). A
 * server-level mutation (no `appId`) waits for every job, task runs and
 * builds included.
 */
export function isServerMutationBlocked(
	state: LockState,
	serverId: string,
	appId?: string | null,
): boolean {
	if (state.serverLocks.has(serverId)) return true;
	if (appId) return state.serverLocks.has(appLockKey(appId));
	return hasAppLockOn(state, serverId);
}
