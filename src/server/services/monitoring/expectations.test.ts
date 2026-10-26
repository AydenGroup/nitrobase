import { describe, expect, it } from "vitest";
import { evaluateRules } from "./alert-rules";
import { appExpectations } from "./expectations";
import type { ContainerSample } from "./types";

const settings = {
	diskPercent: 85,
	memoryPercent: 90,
	hysteresisPercent: 5,
	restartLoopCount: 3,
	restartLoopWindowMs: 10 * 60_000,
	unreachableFailures: 3,
};

const exited = (service: string): ContainerSample => ({
	ts: 0,
	container: `aw-${service}`,
	appLabel: "app-1",
	project: "aw",
	appId: "app-1",
	service,
	state: "exited",
	health: null,
	restartCount: 0,
	exitCode: 0,
	cpuPercent: null,
	memUsed: null,
	memLimit: null,
	netRxBps: null,
	netTxBps: null,
});

const verdicts = (
	status: string,
	options: { stopped?: string[]; busy?: boolean } = {},
) =>
	evaluateRules({
		now: 0,
		server: null,
		containers: [exited("postgresql"), exited("worker")],
		failures: 0,
		restartHistory: new Map(),
		settings,
		apps: appExpectations(
			[
				{
					id: "app-1",
					status,
					stoppedServices: options.stopped ?? null,
				},
			],
			new Map(),
			() => options.busy ?? false,
		),
	})
		.get("container_exited")
		?.map((item) => [item.subject, item.verdict]);

describe("app expectations at alert time (BUG-015)", () => {
	it("follows the status read after the tick, not before it", () => {
		// The owner pressed Stop while the tick's command ran: the row read
		// for the alerts says stopped, so nothing fires.
		expect(verdicts("stopped")).toEqual([
			["aw-postgresql", "clear"],
			["aw-worker", "clear"],
		]);
		expect(verdicts("running")).toEqual([
			["aw-postgresql", "fire"],
			["aw-worker", "fire"],
		]);
	});

	it("holds while a job holds the app", () => {
		expect(verdicts("running", { busy: true })).toEqual([
			["aw-postgresql", "hold"],
			["aw-worker", "hold"],
		]);
	});

	it("leaves services the owner stopped one by one alone", () => {
		expect(verdicts("running", { stopped: ["worker"] })).toEqual([
			["aw-postgresql", "fire"],
			["aw-worker", "clear"],
		]);
	});
});
