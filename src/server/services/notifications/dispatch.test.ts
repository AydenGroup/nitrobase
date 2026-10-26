import { describe, expect, it } from "vitest";
import {
	admitDelivery,
	dedupeKeyOf,
	matchesSubscription,
	retryDelayMs,
	scrubSecrets,
} from "./dispatch";

const sub = (overrides = {}) => ({
	events: ["alert.opened", "security.new_login"],
	serverIds: [] as string[],
	appIds: [] as string[],
	...overrides,
});

describe("matchesSubscription", () => {
	it("needs the event id subscribed", () => {
		expect(matchesSubscription(sub(), { id: "alert.opened" })).toBe(true);
		expect(matchesSubscription(sub(), { id: "backup.failed" })).toBe(false);
	});

	it("narrows by server or app when filters are set", () => {
		const narrowed = sub({ serverIds: ["s1"], appIds: ["a2"] });
		expect(
			matchesSubscription(narrowed, { id: "alert.opened", serverId: "s1" }),
		).toBe(true);
		expect(
			matchesSubscription(narrowed, {
				id: "alert.opened",
				serverId: "s9",
				appId: "a2",
			}),
		).toBe(true);
		expect(
			matchesSubscription(narrowed, {
				id: "alert.opened",
				serverId: "s9",
				appId: "a9",
			}),
		).toBe(false);
		// Events about no server/app are not narrowed.
		expect(matchesSubscription(narrowed, { id: "security.new_login" })).toBe(
			true,
		);
	});
});

describe("admitDelivery", () => {
	const now = new Date("2026-10-05T12:00:00Z");
	const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
	const options = {
		dedupeWindowMs: 30 * 60_000,
		rateLimit: 3,
		rateWindowMs: 60 * 60_000,
	};

	it("suppresses the same key inside the dedupe window", () => {
		const recent = [
			{ dedupeKey: "k", status: "sent" as const, createdAt: ago(10) },
		];
		expect(admitDelivery(recent, "k", now, options)).toEqual({
			send: false,
			reason: "duplicate",
		});
		expect(admitDelivery(recent, "other", now, options)).toEqual({
			send: true,
		});
	});

	it("lets the key through after the window or when the earlier one failed", () => {
		expect(
			admitDelivery(
				[{ dedupeKey: "k", status: "sent", createdAt: ago(31) }],
				"k",
				now,
				options,
			),
		).toEqual({ send: true });
		expect(
			admitDelivery(
				[{ dedupeKey: "k", status: "failed", createdAt: ago(1) }],
				"k",
				now,
				options,
			),
		).toEqual({ send: true });
	});

	it("always admits critical events (no dedupe, no rate limit)", () => {
		const recent = ["a", "b", "c", "k"].map((key) => ({
			dedupeKey: key,
			status: "sent" as const,
			createdAt: ago(5),
		}));
		expect(admitDelivery(recent, "k", now, options).send).toBe(false);
		expect(
			admitDelivery(recent, "k", now, { ...options, critical: true }),
		).toEqual({ send: true });
		expect(
			admitDelivery(recent, "new", now, { ...options, critical: true }),
		).toEqual({ send: true });
	});

	it("caps deliveries per channel per window (alert storms)", () => {
		const recent = ["a", "b", "c"].map((key) => ({
			dedupeKey: key,
			status: "sent" as const,
			createdAt: ago(5),
		}));
		expect(admitDelivery(recent, "d", now, options)).toEqual({
			send: false,
			reason: "rate_limited",
		});
		const suppressed = recent.map((row) => ({
			...row,
			status: "suppressed" as const,
		}));
		expect(admitDelivery(suppressed, "d", now, options)).toEqual({
			send: true,
		});
	});
});

describe("retries and secrets", () => {
	it("backs off exponentially from the base", () => {
		expect([2, 3, 4].map((attempt) => retryDelayMs(attempt, 5000))).toEqual([
			5000, 10000, 20000,
		]);
	});

	it("builds dedupe keys from event and subject", () => {
		expect(dedupeKeyOf({ id: "alert.opened", subject: "disk_usage:/" })).toBe(
			"alert.opened|disk_usage:/",
		);
	});

	it("scrubs secrets from errors", () => {
		expect(
			scrubSecrets("POST https://x/bot123:SECRETTOKEN/sendMessage failed", [
				"123:SECRETTOKEN",
				"abc",
			]),
		).toBe("POST https://x/bot[redacted]/sendMessage failed");
	});
});
