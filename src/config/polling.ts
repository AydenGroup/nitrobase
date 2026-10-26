/**
 * Client refresh timing (milliseconds, client-safe). Queries pick a
 * freshness tier by how fast their data changes instead of a number of
 * their own; views of running work poll with `pollWhile`.
 */

/** React Query `staleTime` tiers. */
export const STALE_MS = {
	/** Job lists, runs and statuses that change while work runs. */
	live: 5_000,
	/** Lists with statuses (apps, databases, tasks). */
	short: 10_000,
	/** Overviews and lists that change on user actions. */
	default: 15_000,
	/** Settings, servers, monitoring history. */
	medium: 30_000,
	/** Keys, teams, template details. */
	long: 60_000,
	/** Session, template catalog. */
	static: 5 * 60_000,
	/** Data that only changes on rare actions (destination drivers). */
	rare: 30 * 60_000,
} as const;

/** React Query `refetchInterval` tiers. */
export const POLL_MS = {
	/** While something runs (a job, a deploy, a bootstrap, a build). */
	busy: 3_000,
	/** Lists whose items change state on their own. */
	list: 10_000,
	/** Navigation badges, dashboard, notifications. */
	background: 15_000,
	/** Open alerts. */
	alerts: 30_000,
	/** Monitoring history (about once per raw bin; live charts use SSE). */
	history: 60_000,
} as const;

/** How long unused query data is kept (`gcTime`) for the session. */
export const SESSION_GC_MS = 10 * 60_000;

/** `refetchInterval` of a view that polls only while `busy`. */
export function pollWhile(busy: boolean): number | false {
	return busy ? POLL_MS.busy : false;
}

/** Refresh intervals of update views. */
export const UPDATE_POLLING = {
	/** App update badges and lists. */
	appUpdatesStaleMs: 60_000,
	/** Release check shown on the dashboard. */
	releaseStaleMs: 10 * 60_000,
	/** Settings → Instance upgrade card. */
	upgradeOverviewStaleMs: 30_000,
	/** Maintenance window text. */
	windowStaleMs: 10 * 60_000,
	/** A running bulk update's summary. */
	batchRefetchMs: POLL_MS.busy,
} as const;
