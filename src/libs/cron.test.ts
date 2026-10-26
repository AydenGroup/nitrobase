import { describe, expect, it } from "vitest";
import {
	buildSchedule,
	isValidCron,
	minIntervalMinutes,
	missedRunAt,
	nextRunAt,
	parseSchedule,
} from "./cron";

describe("schedule form", () => {
	it("reads presets back from cron and writes them", () => {
		expect(parseSchedule("0 4 * * *")).toEqual({
			preset: "daily",
			hour: 4,
			weekday: 0,
		});
		expect(parseSchedule("0 22 * * 5")).toEqual({
			preset: "weekly",
			hour: 22,
			weekday: 5,
		});
		expect(parseSchedule("*/5 * * * *").preset).toBe("custom");
		expect(buildSchedule({ preset: "weekly", hour: 2, weekday: 1 }, "")).toBe(
			"0 2 * * 1",
		);
		expect(
			buildSchedule({ preset: "custom", hour: 0, weekday: 0 }, " 1 2 * * * "),
		).toBe("1 2 * * *");
	});

	it("gives the next tick, null for invalid cron", () => {
		expect(
			nextRunAt("0 3 * * *", {
				timezone: "UTC",
				after: new Date("2026-10-01T04:00:00Z"),
			})?.toISOString(),
		).toBe("2026-10-02T03:00:00.000Z");
		expect(nextRunAt("not a cron")).toBeNull();
	});
});

describe("missedRunAt", () => {
	const daily = "0 3 * * *";
	it("detects a tick missed while down", () => {
		expect(
			missedRunAt({
				cron: daily,
				lastRunAt: new Date("2026-10-01T03:00:05Z"),
				createdAt: new Date("2026-09-01T00:00:00Z"),
				now: new Date("2026-10-02T09:00:00Z"),
				timezone: "UTC",
			})?.toISOString(),
		).toBe("2026-10-02T03:00:00.000Z");
	});
	it("is null when the last run is the latest tick", () => {
		expect(
			missedRunAt({
				cron: daily,
				lastRunAt: new Date("2026-10-02T03:00:05Z"),
				createdAt: new Date("2026-09-01T00:00:00Z"),
				now: new Date("2026-10-02T09:00:00Z"),
				timezone: "UTC",
			}),
		).toBeNull();
	});
	it("uses the creation time before the first run", () => {
		expect(
			missedRunAt({
				cron: daily,
				lastRunAt: null,
				createdAt: new Date("2026-10-02T08:00:00Z"),
				now: new Date("2026-10-02T09:00:00Z"),
				timezone: "UTC",
			}),
		).toBeNull();
	});
});

describe("cron validation", () => {
	it("validates and measures intervals", () => {
		expect(isValidCron("0 3 * * *")).toBe(true);
		expect(isValidCron("not cron")).toBe(false);
		expect(minIntervalMinutes("*/5 * * * *")).toBe(5);
		expect(minIntervalMinutes("0 3 * * 0")).toBe(7 * 24 * 60);
	});
});
