import { createHash } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "#/db/index.ts";
import { rateLimits } from "#/db/schema/user.ts";
import {
	createRateLimiter,
	type RateLimiter,
} from "#/server/services/rate-limit.ts";

/**
 * A rate limiter whose counters are also stored in `rate_limits`, so a
 * restart does not clear a lockout. Memory stays the front: checks are
 * synchronous after `ready()` loaded the scope's live counters once; every
 * change is written through. Keys are hashed before they reach either.
 */
export interface PersistentRateLimiter {
	ready(): Promise<void>;
	isLimited(key: string): boolean;
	hit(key: string): number;
	reset(key: string): void;
	retryAfterMs(key: string): number;
}

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function persistentRateLimiter(
	scope: string,
	options: { limit: number; windowMs: number },
): PersistentRateLimiter {
	const write = (
		keyHash: string,
		entry: { count: number; start: number } | null,
	) => {
		const query = entry
			? db
					.insert(rateLimits)
					.values({
						scope,
						keyHash,
						count: entry.count,
						windowStart: new Date(entry.start),
					})
					.onConflictDoUpdate({
						target: [rateLimits.scope, rateLimits.keyHash],
						// Writes are fire-and-forget and may land out of order: in the
						// same window the count never goes down; a newer window wins.
						set: {
							count: sql`case when ${rateLimits.windowStart} = excluded.window_start then greatest(${rateLimits.count}, excluded.count) when ${rateLimits.windowStart} < excluded.window_start then excluded.count else ${rateLimits.count} end`,
							windowStart: sql`greatest(${rateLimits.windowStart}, excluded.window_start)`,
						},
					})
			: db
					.delete(rateLimits)
					.where(
						and(eq(rateLimits.scope, scope), eq(rateLimits.keyHash, keyHash)),
					);
		void Promise.resolve(query).catch((error) =>
			console.error(`[rate-limit] could not persist ${scope}:`, error),
		);
	};
	const limiter: RateLimiter = createRateLimiter({
		...options,
		onChange: write,
	});
	let loaded: Promise<void> | null = null;
	const load = async () => {
		const cutoff = new Date(Date.now() - options.windowMs);
		// Windows that are over can never limit again.
		await db
			.delete(rateLimits)
			.where(
				and(eq(rateLimits.scope, scope), lt(rateLimits.windowStart, cutoff)),
			);
		const rows = await db
			.select()
			.from(rateLimits)
			.where(
				and(eq(rateLimits.scope, scope), gt(rateLimits.windowStart, cutoff)),
			);
		for (const row of rows) {
			limiter.seed(row.keyHash, {
				count: row.count,
				start: row.windowStart.getTime(),
			});
		}
	};
	return {
		ready: () => {
			loaded ??= load().catch((error) => {
				// Retry on the next call; memory limits still apply meanwhile.
				loaded = null;
				console.error(`[rate-limit] could not load ${scope}:`, error);
			});
			return loaded;
		},
		isLimited: (key) => limiter.isLimited(hashKey(key)),
		hit: (key) => limiter.hit(hashKey(key)),
		reset: (key) => limiter.reset(hashKey(key)),
		retryAfterMs: (key) => limiter.retryAfterMs(hashKey(key)),
	};
}

/**
 * Drop counters whose window is over (scheduled, RATE_LIMIT_PRUNE_CRON):
 * keys rotate (e.g. an attacker's IPs), so the table must not only shrink
 * at boot.
 */
export async function pruneRateLimits(
	maxWindowMs: number,
	now = new Date(),
): Promise<number> {
	const removed = await db
		.delete(rateLimits)
		.where(lt(rateLimits.windowStart, new Date(now.getTime() - maxWindowMs)))
		.returning({ scope: rateLimits.scope });
	return removed.length;
}
