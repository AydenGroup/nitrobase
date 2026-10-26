import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { POLL_MS, pollWhile } = await import("./polling");
const { appStatuses, interruptibleStatuses, deploymentStatuses, isBusy } =
	await import("./status");

describe("polling", () => {
	it("polls only while busy", () => {
		expect(pollWhile(true)).toBe(POLL_MS.busy);
		expect(pollWhile(false)).toBe(false);
	});

	it("reads in-progress statuses from the registries", () => {
		expect(isBusy(appStatuses, "deploying")).toBe(true);
		// Pending is not busy (actions stay usable), but boot recovery resets it.
		expect(isBusy(appStatuses, "pending")).toBe(false);
		expect(isBusy(appStatuses, "running")).toBe(false);
		expect(isBusy(deploymentStatuses, "running")).toBe(true);
		expect(isBusy(appStatuses, "nope")).toBe(false);
		expect(isBusy(appStatuses, undefined)).toBe(false);
		expect(interruptibleStatuses(appStatuses).sort()).toEqual([
			"deleting",
			"deploying",
			"pending",
		]);
	});
});
