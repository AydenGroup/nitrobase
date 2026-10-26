import { describe, expect, it } from "vitest";
import { lowMemoryLimits } from "./resource-limits.ts";

/**
 * A memory limit below what a service uses now gets the service killed
 * (out of memory) by the next redeploy: the Resource limits card warns.
 */

const MIB = 1024 * 1024;

const usage = (service: string, memUsedMib: number | null) => ({
	service,
	memUsed: memUsedMib === null ? null : memUsedMib * MIB,
});

describe("lowMemoryLimits", () => {
	it("lists a service whose limit is below its current use", () => {
		const result = lowMemoryLimits({ kong: { memoryMb: 64 } }, [
			usage("kong", 632),
		]);
		expect(result).toEqual([{ service: "kong", limitMb: 64, usedMb: 632 }]);
	});

	it("ignores a limit at or above the current use", () => {
		const result = lowMemoryLimits(
			{ kong: { memoryMb: 632 }, auth: { memoryMb: 768 } },
			[usage("kong", 632), usage("auth", 14)],
		);
		expect(result).toEqual([]);
	});

	it("ignores services without a limit", () => {
		expect(
			lowMemoryLimits({ kong: { memoryMb: null } }, [usage("kong", 632)]),
		).toEqual([]);
	});

	it("ignores services without a usage sample", () => {
		expect(
			lowMemoryLimits({ kong: { memoryMb: 64 }, db: { memoryMb: 64 } }, [
				usage("kong", null),
			]),
		).toEqual([]);
	});

	it("reports every low service, in the order of the limits", () => {
		const result = lowMemoryLimits(
			{ db: { memoryMb: 50 }, kong: { memoryMb: 64 }, auth: { memoryMb: 512 } },
			[usage("kong", 632), usage("db", 107), usage("auth", 14)],
		);
		expect(result.map((item) => item.service)).toEqual(["db", "kong"]);
	});

	it("rounds the used memory up so the warning never understates it", () => {
		const result = lowMemoryLimits({ kong: { memoryMb: 100 } }, [
			{ service: "kong", memUsed: 100.2 * MIB },
		]);
		expect(result).toEqual([{ service: "kong", limitMb: 100, usedMb: 101 }]);
	});
});
