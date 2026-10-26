import type { JobTitleSource } from "#/config/job-titles.ts";
import type { EventSeverity } from "#/config/notification-events.ts";
import type { CodedValue } from "#/libs/coded.ts";

/**
 * In-process platform event bus (single instance). Producers call
 * `emitEvent` with a catalog id (#/config/notification-events.ts); the
 * notification dispatcher subscribes. Listeners run detached: emitting
 * never waits for or fails because of delivery. On globalThis so dev HMR
 * reloads don't drop or duplicate subscribers.
 */
export interface PlatformEvent {
	/** Catalog event id. */
	id: string;
	/** Team whose channels receive it; null for account events (sign-in, 2FA). */
	teamId: string | null;
	/**
	 * Member it is about. Account events (no team) reach the channels this
	 * member created, in any team.
	 */
	userId?: string | null;
	/** What it is about (mount, container, host, job id): the dedupe key. */
	subject: string;
	serverId?: string | null;
	appId?: string | null;
	/**
	 * Template params (never secrets): text, or coded values (errors, job
	 * titles, sizes) rendered in the channel's language.
	 */
	params: Record<string, CodedValue | { $job: JobTitleSource }>;
	/** Overrides the catalog severity (e.g. a critical alert rule). */
	severity?: EventSeverity;
	at?: Date;
}

export type EventListener = (event: PlatformEvent) => Promise<void> | void;

const globalBus = globalThis as typeof globalThis & {
	__nitrobaseEventListeners?: Set<EventListener>;
};
globalBus.__nitrobaseEventListeners ??= new Set();
const listeners = globalBus.__nitrobaseEventListeners;

export function onEvent(listener: EventListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function emitEvent(event: PlatformEvent): void {
	const stamped = { ...event, at: event.at ?? new Date() };
	for (const listener of [...listeners]) {
		void Promise.resolve()
			.then(() => listener(stamped))
			.catch((error) => console.error("[events] listener failed", error));
	}
}
