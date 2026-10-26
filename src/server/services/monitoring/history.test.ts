import { describe, expect, it } from "vitest";
import {
	bucketStart,
	historyPlan,
	retentionCutoffs,
	rollupWindow,
} from "./history";

const settings = {
	intervalSeconds: 15,
	rawRetentionSeconds: 24 * 3600,
	rollupBucketSeconds: 300,
	rollupRetentionSeconds: 7 * 86400,
	points: 240,
};
const now = new Date("2026-10-05T12:07:30Z");

describe("historyPlan", () => {
	it("uses raw samples at the collection interval for 1h", () => {
		const plan = historyPlan(3600, now, settings);
		expect(plan.bucketSeconds).toBe(0);
		expect(plan.binSeconds).toBe(15);
		expect(plan.from.toISOString()).toBe("2026-10-05T11:07:30.000Z");
	});

	it("uses raw samples with wider bins for 24h (still within raw retention)", () => {
		const plan = historyPlan(86400, now, settings);
		expect(plan.bucketSeconds).toBe(0);
		// 86400 / 240 = 360, a multiple of 15.
		expect(plan.binSeconds).toBe(360);
	});

	it("switches to rollups past raw retention, bins a multiple of the bucket", () => {
		const plan = historyPlan(7 * 86400, now, settings);
		expect(plan.bucketSeconds).toBe(300);
		// 604800 / 240 = 2520 → next multiple of 300.
		expect(plan.binSeconds).toBe(2700);
	});

	it("uses rollups for 24h when raw retention is shorter", () => {
		const plan = historyPlan(86400, now, {
			...settings,
			rawRetentionSeconds: 6 * 3600,
		});
		expect(plan.bucketSeconds).toBe(300);
		expect(plan.binSeconds).toBe(600);
	});
});

describe("retention and rollup windows", () => {
	it("cuts raw rows after raw retention and rollups after rollup retention", () => {
		const cutoffs = retentionCutoffs(now, settings);
		expect(cutoffs.raw.toISOString()).toBe("2026-10-04T12:07:30.000Z");
		expect(cutoffs.rollup.toISOString()).toBe("2026-09-28T12:07:30.000Z");
	});

	it("aligns buckets to the epoch", () => {
		expect(bucketStart(now, 300).toISOString()).toBe(
			"2026-10-05T12:05:00.000Z",
		);
	});

	it("rolls up complete buckets only, over the lookback", () => {
		const window = rollupWindow(now, 300, 30 * 60);
		expect(window?.from.toISOString()).toBe("2026-10-05T11:35:00.000Z");
		// The 12:05 bucket is still filling.
		expect(window?.to.toISOString()).toBe("2026-10-05T12:05:00.000Z");
	});

	it("has nothing to do when the lookback is inside the current bucket", () => {
		expect(rollupWindow(now, 300, 60)).toBeNull();
	});
});
