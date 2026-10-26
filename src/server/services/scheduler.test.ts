import { afterEach, describe, expect, it } from "vitest";
import { schedule, stopScheduler, unschedule } from "./scheduler";

afterEach(() => stopScheduler());

describe("scheduler", () => {
	it("registers, replaces and removes named tasks", () => {
		const first = schedule("noop", "0 3 * * *", () => {});
		const second = schedule("noop", "*/5 * * * *", () => {});
		expect(first.isStopped()).toBe(true);
		expect(second.nextRun()).toBeInstanceOf(Date);

		expect(unschedule("noop")).toBe(true);
		expect(second.isStopped()).toBe(true);
		expect(unschedule("noop")).toBe(false);
	});

	it("swallows task errors", async () => {
		let ran = false;
		const job = schedule("boom", "0 0 1 1 *", () => {
			ran = true;
			throw new Error("boom");
		});
		await job.trigger();
		expect(ran).toBe(true);
	});
});
