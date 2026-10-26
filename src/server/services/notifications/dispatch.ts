import { TEXT_LIMITS } from "#/config/text-limits.ts";
import type { ChannelSubscription } from "#/db/schema/platform.ts";
import { clip } from "#/libs/format.ts";
import type { PlatformEvent } from "#/server/services/events/bus.ts";

/**
 * Channel routing rules. Pure (tested).
 *
 * An event reaches a channel when its id is subscribed and, if the channel
 * narrows to servers/apps, the event concerns one of them. Events about no
 * server or app (sign-ins, 2FA) are not narrowed.
 */
export function matchesSubscription(
	subscription: ChannelSubscription,
	event: Pick<PlatformEvent, "id" | "serverId" | "appId">,
): boolean {
	if (!subscription.events.includes(event.id)) return false;
	const narrowed =
		subscription.serverIds.length > 0 || subscription.appIds.length > 0;
	if (!narrowed || (!event.serverId && !event.appId)) return true;
	return (
		(!!event.serverId && subscription.serverIds.includes(event.serverId)) ||
		(!!event.appId && subscription.appIds.includes(event.appId))
	);
}

export interface RecentDelivery {
	dedupeKey: string;
	status: "pending" | "sent" | "failed" | "suppressed";
	createdAt: Date;
}

export type Admission =
	| { send: true }
	| { send: false; reason: "duplicate" | "rate_limited" };

/**
 * Dedupe (same key within the window, unless the earlier one failed) and
 * a per-channel cap of deliveries per rate window. `critical` events (event
 * catalog flag) skip both.
 */
export function admitDelivery(
	recent: RecentDelivery[],
	dedupeKey: string,
	now: Date,
	options: {
		dedupeWindowMs: number;
		rateLimit: number;
		rateWindowMs: number;
		critical?: boolean;
	},
): Admission {
	if (options.critical) return { send: true };
	const live = (row: RecentDelivery) =>
		row.status === "sent" || row.status === "pending";
	const age = (row: RecentDelivery) => now.getTime() - row.createdAt.getTime();
	if (
		recent.some(
			(row) =>
				row.dedupeKey === dedupeKey &&
				live(row) &&
				age(row) < options.dedupeWindowMs,
		)
	) {
		return { send: false, reason: "duplicate" };
	}
	const inWindow = recent.filter(
		(row) => live(row) && age(row) < options.rateWindowMs,
	).length;
	if (inWindow >= options.rateLimit) {
		return { send: false, reason: "rate_limited" };
	}
	return { send: true };
}

/** Wait before attempt `attempt` (2, 3, ...): base, 2×base, 4×base... */
export function retryDelayMs(attempt: number, baseMs: number): number {
	return baseMs * 2 ** Math.max(0, attempt - 2);
}

export const dedupeKeyOf = (event: Pick<PlatformEvent, "id" | "subject">) =>
	clip(`${event.id}|${event.subject}`, TEXT_LIMITS.message);

/** Scrub channel secrets from error text before it is stored or logged. */
export function scrubSecrets(text: string, secrets: string[]): string {
	return secrets
		.filter((value) => value.length >= 6)
		.reduce((out, value) => out.split(value).join("[redacted]"), text);
}
