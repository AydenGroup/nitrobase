/**
 * Fixed-window counters in memory (single instance). `check` tells whether
 * a key may try again; `hit` records an attempt (callers hit on failures
 * only, so a user who signs in fine is never limited). Pure: `now` is
 * injectable. `onChange` lets a store persist counters (so a restart does
 * not clear them) and `seed` loads them back.
 */
export interface RateLimiter {
	isLimited(key: string): boolean;
	hit(key: string): number;
	reset(key: string): void;
	/** Milliseconds until `key` may try again (0 when not limited). */
	retryAfterMs(key: string): number;
	/** Load a stored counter (ignored when its window is over). */
	seed(key: string, entry: RateLimitEntry): void;
}

export interface RateLimitEntry {
	count: number;
	/** Window start, epoch milliseconds. */
	start: number;
}

/** Keys a limiter holds before expired ones are dropped. */
const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter(options: {
	limit: number;
	windowMs: number;
	now?: () => number;
	/** Drop expired entries once the map grows past this. */
	maxKeys?: number;
	/** Called after a counter changes (`null` = reset). */
	onChange?: (key: string, entry: RateLimitEntry | null) => void;
}): RateLimiter {
	const now = options.now ?? Date.now;
	const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
	const entries = new Map<string, RateLimitEntry>();
	const current = (key: string) => {
		const entry = entries.get(key);
		if (entry && now() - entry.start >= options.windowMs) {
			entries.delete(key);
			return null;
		}
		return entry ?? null;
	};
	const sweep = () => {
		if (entries.size <= maxKeys) return;
		for (const key of [...entries.keys()]) current(key);
	};
	return {
		isLimited: (key) => (current(key)?.count ?? 0) >= options.limit,
		hit: (key) => {
			const entry = current(key) ?? { count: 0, start: now() };
			entry.count += 1;
			entries.set(key, entry);
			sweep();
			options.onChange?.(key, { ...entry });
			return entry.count;
		},
		reset: (key) => {
			if (entries.delete(key)) options.onChange?.(key, null);
		},
		retryAfterMs: (key) => {
			const entry = current(key);
			if (!entry || entry.count < options.limit) return 0;
			return Math.max(0, entry.start + options.windowMs - now());
		},
		seed: (key, entry) => {
			if (now() - entry.start >= options.windowMs) return;
			const existing = entries.get(key);
			if (!existing || existing.count < entry.count) {
				entries.set(key, { ...entry });
			}
		},
	};
}
