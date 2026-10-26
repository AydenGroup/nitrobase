import { describe, expect, it } from "vitest";
import { nextStoppedServices } from "./stopped-services";

describe("services stopped by the owner", () => {
	it("adds a stopped service once and drops it on start or restart", () => {
		expect(nextStoppedServices(undefined, "stop", "worker")).toEqual([
			"worker",
		]);
		expect(nextStoppedServices(["worker"], "stop", "worker")).toEqual([
			"worker",
		]);
		expect(nextStoppedServices(["worker", "db"], "start", "worker")).toEqual([
			"db",
		]);
		expect(
			nextStoppedServices(["worker"], "restart", "worker"),
		).toBeUndefined();
	});

	it("clears the list on an action on the whole app", () => {
		for (const action of ["start", "stop", "restart"] as const) {
			expect(nextStoppedServices(["worker"], action)).toBeUndefined();
		}
	});
});
