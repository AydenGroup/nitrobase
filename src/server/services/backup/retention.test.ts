import { describe, expect, it } from "vitest";
import { selectExpired } from "./retention";

const now = new Date("2026-10-10T00:00:00Z");
const day = 24 * 60 * 60 * 1000;
const backup = (
	id: string,
	daysAgo: number,
	status: "success" | "failed" = "success",
) => ({
	id,
	status,
	createdAt: new Date(now.getTime() - daysAgo * day),
});
const all = [
	backup("a", 0),
	backup("b", 1),
	backup("c", 2),
	backup("d", 10),
	backup("e", 30),
	backup("f", 3, "failed"),
];
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe("selectExpired", () => {
	it("keeps everything without rules", () => {
		expect(selectExpired(all, { keepLast: null, keepDays: null }, now)).toEqual(
			[],
		);
	});
	it("keeps the newest N", () => {
		expect(
			ids(selectExpired(all, { keepLast: 2, keepDays: null }, now)),
		).toEqual(["c", "d", "e"]);
	});
	it("keeps the last D days", () => {
		expect(
			ids(selectExpired(all, { keepLast: null, keepDays: 7 }, now)),
		).toEqual(["d", "e"]);
	});
	it("keeps the union of both rules and never touches failed rows", () => {
		expect(ids(selectExpired(all, { keepLast: 4, keepDays: 1 }, now))).toEqual([
			"e",
		]);
	});
	it("never prunes the newest successful backup", () => {
		expect(
			ids(
				selectExpired(
					[backup("old", 100)],
					{ keepLast: null, keepDays: 1 },
					now,
				),
			),
		).toEqual([]);
	});
});
