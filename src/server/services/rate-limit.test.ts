import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
	it("limits after N hits inside the window and frees the key afterwards", () => {
		let now = 0;
		const limiter = createRateLimiter({
			limit: 3,
			windowMs: 1000,
			now: () => now,
		});
		expect(limiter.isLimited("ip")).toBe(false);
		limiter.hit("ip");
		limiter.hit("ip");
		expect(limiter.isLimited("ip")).toBe(false);
		limiter.hit("ip");
		expect(limiter.isLimited("ip")).toBe(true);
		expect(limiter.isLimited("other")).toBe(false);
		now = 400;
		expect(limiter.retryAfterMs("ip")).toBe(600);
		now = 1000;
		expect(limiter.isLimited("ip")).toBe(false);
		expect(limiter.retryAfterMs("ip")).toBe(0);
	});

	it("reset clears a key (successful sign-in)", () => {
		const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
		limiter.hit("a");
		expect(limiter.isLimited("a")).toBe(true);
		limiter.reset("a");
		expect(limiter.isLimited("a")).toBe(false);
	});

	it("reports changes and can be seeded back (survives a restart)", () => {
		let now = 0;
		const changes: [string, unknown][] = [];
		const first = createRateLimiter({
			limit: 2,
			windowMs: 1000,
			now: () => now,
			onChange: (key, entry) => changes.push([key, entry]),
		});
		first.hit("k");
		first.hit("k");
		expect(changes.at(-1)).toEqual(["k", { count: 2, start: 0 }]);
		const restarted = createRateLimiter({
			limit: 2,
			windowMs: 1000,
			now: () => now,
		});
		restarted.seed("k", { count: 2, start: 0 });
		expect(restarted.isLimited("k")).toBe(true);
		// Expired counters are not loaded.
		now = 1500;
		const later = createRateLimiter({
			limit: 2,
			windowMs: 1000,
			now: () => now,
		});
		later.seed("k", { count: 2, start: 0 });
		expect(later.isLimited("k")).toBe(false);
		first.reset("k");
		expect(changes.at(-1)).toEqual(["k", null]);
	});

	it("keeps the window fixed from the first failure (checks don't count)", () => {
		let now = 0;
		const limiter = createRateLimiter({
			limit: 2,
			windowMs: 1000,
			now: () => now,
		});
		limiter.hit("k");
		now = 100;
		limiter.hit("k");
		// Blocked attempts only check: the window doesn't move.
		for (now = 200; now < 900; now += 100)
			expect(limiter.isLimited("k")).toBe(true);
		expect(limiter.retryAfterMs("k")).toBe(100);
		now = 1000;
		expect(limiter.isLimited("k")).toBe(false);
	});
});
