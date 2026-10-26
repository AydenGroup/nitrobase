import { describe, expect, it } from "vitest";
import {
	EMPTY_VALUE,
	formatBytes,
	formatDate,
	formatDuration,
	formatNumber,
	formatPercent,
	formatRate,
	formatUptime,
} from "./intl";

// Intl output may contain non-breaking spaces: normalize before comparing.
const plain = (value: string) => value.replace(/[  ]/g, " ");

describe("intl helpers", () => {
	it("formats numbers per locale", () => {
		expect(formatNumber("en", 1234.5)).toBe("1,234.5");
		expect(plain(formatNumber("vi", 1234.5))).toBe("1.234,5");
		expect(formatNumber("en", null)).toBe(EMPTY_VALUE);
	});

	it("formats percent from a ratio", () => {
		expect(formatPercent("en", 0.045)).toBe("4.5%");
		expect(formatPercent("en", 0.634)).toBe("63%");
		expect(plain(formatPercent("vi", 0.045))).toBe("4,5%");
		expect(formatPercent("en", undefined)).toBe(EMPTY_VALUE);
	});

	it("formats bytes and rates", () => {
		expect(plain(formatBytes("en", 512))).toBe("512 byte");
		expect(plain(formatBytes("en", 1536 * 1024))).toBe("1.5 MB");
		expect(plain(formatBytes("vi", 1536 * 1024))).toBe("1,5 MB");
		expect(plain(formatRate("en", 2048))).toBe("2 kB/s");
		expect(formatBytes("en", null)).toBe(EMPTY_VALUE);
	});

	it("formats durations", () => {
		expect(plain(formatDuration("en", 5_000))).toBe("5s");
		expect(plain(formatDuration("en", 65_000))).toBe("1m 5s");
		expect(plain(formatUptime("en", 2 * 86_400 + 3 * 3600))).toBe("2d 3h");
	});

	it("formats dates and caches formatters", () => {
		const date = new Date(Date.UTC(2026, 0, 2, 3, 4));
		const options = { dateStyle: "medium", timeZone: "UTC" } as const;
		expect(formatDate("en", date, options)).toBe("Jan 2, 2026");
		expect(formatDate("en", date.toISOString(), options)).toBe("Jan 2, 2026");
		expect(formatDate("en", "not a date")).toBe(EMPTY_VALUE);
	});
});

describe("relative time and offsets", () => {
	it("formats relative times in the locale", async () => {
		const { formatRelativeTime, formatUtcOffset } = await import("./intl");
		const now = Date.UTC(2026, 0, 1, 12, 0, 0);
		expect(formatRelativeTime("en", now - 2 * 60_000, now)).toBe(
			"2 minutes ago",
		);
		expect(formatRelativeTime("en", now + 3 * 3600_000, now)).toBe(
			"in 3 hours",
		);
		expect(formatRelativeTime("en", null, now)).toBe("—");
		expect(formatUtcOffset(420)).toBe("UTC+07:00");
		expect(formatUtcOffset(-330)).toBe("UTC-05:30");
	});
});
