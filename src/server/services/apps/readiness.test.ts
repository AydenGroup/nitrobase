import { describe, expect, it } from "vitest";
import type { ServiceStatus } from "./commands";
import {
	allServicesHealthy,
	ReadinessTracker,
	type ReadinessVerdict,
} from "./readiness";

describe("allServicesHealthy (error banner hint)", () => {
	const sample = (service: string | null, state: string, health = "") => ({
		service,
		state,
		health,
	});

	it("needs a running, healthy sample of every deployed service", () => {
		const services = ["db", "storage"];
		expect(
			allServicesHealthy(services, [
				sample("db", "running", "healthy"),
				sample("storage", "running"),
			]),
		).toBe(true);
		// storage was never sampled (or its container is gone): not recovered.
		expect(
			allServicesHealthy(services, [sample("db", "running", "healthy")]),
		).toBe(false);
		expect(
			allServicesHealthy(services, [
				sample("db", "running", "healthy"),
				sample("storage", "running", "unhealthy"),
			]),
		).toBe(false);
		expect(
			allServicesHealthy(services, [
				sample("db", "running", "healthy"),
				sample("storage", "exited"),
			]),
		).toBe(false);
		expect(allServicesHealthy([], [sample("db", "running")])).toBe(false);
	});
});

const settings = {
	restartLimit: 3,
	stableMs: 20_000,
	stableSamples: 3,
	unhealthyGraceMs: 60_000,
	unhealthySamples: 3,
};
const INTERVAL = 5_000;

const s = (
	service: string,
	state: string,
	restarts = 0,
	extra: Partial<ServiceStatus> = {},
): ServiceStatus => ({
	service,
	state,
	health: "",
	exitCode: 0,
	restarts,
	...extra,
});

/** Feed samples taken every `INTERVAL` ms; returns every verdict. */
function feed(
	tracker: ReadinessTracker,
	samples: ServiceStatus[][],
): ReadinessVerdict[] {
	return samples.map((sample, index) =>
		tracker.observe(sample, index * INTERVAL),
	);
}

describe("ReadinessTracker", () => {
	it("is ready only after the stable window (samples and time)", () => {
		const tracker = new ReadinessTracker(settings);
		const up = [
			s("web", "running"),
			s("db", "running", 0, { health: "healthy" }),
		];
		const verdicts = feed(tracker, [up, up, up, up, up]);
		// t=0..15s: not long enough; t=20s with 5 samples: ready.
		expect(verdicts.map((v) => v.state)).toEqual([
			"pending",
			"pending",
			"pending",
			"pending",
			"ready",
		]);
	});

	it("needs the sample count too, not only the time", () => {
		const tracker = new ReadinessTracker({ ...settings, stableMs: 1_000 });
		const up = [s("web", "running")];
		expect(tracker.observe(up, 0).state).toBe("pending");
		expect(tracker.observe(up, 60_000).state).toBe("pending");
		expect(tracker.observe(up, 120_000).state).toBe("ready");
	});

	it("never reports QA's flap sequence ready and fails it as a restart loop", () => {
		// BUG-004 repro: `good` runs, `flap` is `sleep 3; exit 1` with
		// `restart: always`, sampled every 5 s. Some samples catch it running.
		const tracker = new ReadinessTracker(settings);
		const good = s("good", "running");
		const verdicts = feed(tracker, [
			[good, s("flap", "running", 0)],
			[good, s("flap", "restarting", 1)],
			[good, s("flap", "running", 1)],
			[good, s("flap", "running", 2)],
			[good, s("flap", "restarting", 3)],
			[good, s("flap", "running", 4)],
		]);
		expect(verdicts.slice(0, 4).map((v) => v.state)).toEqual([
			"pending",
			"pending",
			"pending",
			"pending",
		]);
		expect(verdicts[4]).toMatchObject({
			state: "failed",
			failure: { kind: "restart_loop", service: "flap", restarts: 3 },
		});
		expect(verdicts[4].detail).toBe("good=running, flap=restarting ↻3");
	});

	it("restarts the window on a restart below the threshold", () => {
		const tracker = new ReadinessTracker(settings);
		const verdicts = feed(tracker, [
			[s("web", "running", 0)],
			[s("web", "running", 0)],
			[s("web", "running", 0)],
			[s("web", "running", 1)], // restarted between samples
			[s("web", "running", 1)],
			[s("web", "running", 1)],
			[s("web", "running", 1)],
			[s("web", "running", 1)],
		]);
		// From t=15s (the restart) the window needs 20 s again: t=35s.
		expect(verdicts.map((v) => v.state)).toEqual([
			"pending",
			"pending",
			"pending",
			"pending",
			"pending",
			"pending",
			"pending",
			"ready",
		]);
		expect(tracker.restarted()).toEqual([{ service: "web", restarts: 1 }]);
	});

	it("baselines restart counts from before the deploy", () => {
		// A container kept by a redeploy may have restarted long ago.
		const tracker = new ReadinessTracker({
			...settings,
			stableMs: 0,
			stableSamples: 1,
		});
		expect(tracker.observe([s("web", "running", 12)], 0).state).toBe("ready");
		expect(tracker.restarted()).toEqual([]);
		// Recreated: the count starts from 0 again, no negative delta.
		expect(tracker.observe([s("web", "running", 0)], INTERVAL).state).toBe(
			"ready",
		);
	});

	it("treats one-shot exits by code", () => {
		const fast = { ...settings, stableMs: 0, stableSamples: 1 };
		const done = new ReadinessTracker(fast);
		expect(
			done.observe([s("web", "running"), s("migrate", "exited")], 0).state,
		).toBe("ready");

		const failed = new ReadinessTracker(fast);
		const crashed = [
			s("web", "running"),
			s("migrate", "exited", 0, { exitCode: 1 }),
		];
		// Seen once (it may be being restarted): pending; twice: failed.
		expect(failed.observe(crashed, 0).state).toBe("pending");
		expect(failed.observe(crashed, INTERVAL)).toMatchObject({
			state: "failed",
			failure: { kind: "unhealthy" },
			detail: "web=running, migrate=exited(1)",
		});
	});

	it("fails dead services at once and waits for starting ones", () => {
		const tracker = new ReadinessTracker(settings);
		expect(
			tracker.observe([s("web", "running", 0, { health: "starting" })], 0)
				.state,
		).toBe("pending");
		// One unhealthy sample is not a failure (BUG-011): grace window.
		expect(
			tracker.observe([s("web", "running", 0, { health: "unhealthy" })], 1)
				.state,
		).toBe("pending");
		expect(tracker.unhealthyNow).toBe(true);
		expect(
			new ReadinessTracker(settings).observe([s("db", "dead")], 0),
		).toMatchObject({ state: "failed", failure: { kind: "unhealthy" } });
		expect(new ReadinessTracker(settings).observe([], 0).state).toBe("pending");
		expect(
			new ReadinessTracker(settings).observe([s("db", "created")], 0).state,
		).toBe("pending");
	});

	it("rides out a transient unhealthy sample and ends ready (BUG-011)", () => {
		const tracker = new ReadinessTracker(settings);
		const db = s("db", "running", 0, { health: "healthy" });
		const storage = (health: string) => s("storage", "running", 0, { health });
		const verdicts = feed(tracker, [
			[db, storage("starting")],
			[db, storage("unhealthy")],
			[db, storage("healthy")],
			[db, storage("healthy")],
			[db, storage("healthy")],
			[db, storage("healthy")],
			[db, storage("healthy")],
		]);
		expect(verdicts.some((v) => v.state === "failed")).toBe(false);
		expect(verdicts.at(-1)?.state).toBe("ready");
		expect(tracker.unhealthyNow).toBe(false);
	});

	it("fails a service that stays unhealthy past the grace window", () => {
		const tracker = new ReadinessTracker(settings);
		const sick = [s("web", "running", 0, { health: "unhealthy" })];
		expect(tracker.observe(sick, 0).state).toBe("pending");
		expect(tracker.observe(sick, 30_000).state).toBe("pending");
		// Enough samples but not enough time yet.
		expect(tracker.observe(sick, 59_999).state).toBe("pending");
		expect(tracker.observe(sick, 60_000)).toMatchObject({
			state: "failed",
			failure: { kind: "unhealthy" },
			detail: "web=running/unhealthy",
		});
	});

	it("needs the sample count too before failing as unhealthy", () => {
		const tracker = new ReadinessTracker(settings);
		const sick = [s("web", "running", 0, { health: "unhealthy" })];
		expect(tracker.observe(sick, 0).state).toBe("pending");
		expect(tracker.observe(sick, 120_000).state).toBe("pending");
		expect(tracker.observe(sick, 125_000).state).toBe("failed");
	});

	it("starts the unhealthy grace over on healthy, starting or a restart", () => {
		const tracker = new ReadinessTracker(settings);
		const web = (health: string, restarts = 0) => [
			s("web", "running", restarts, { health }),
		];
		expect(tracker.observe(web("unhealthy"), 0).state).toBe("pending");
		expect(tracker.observe(web("unhealthy"), 30_000).state).toBe("pending");
		expect(tracker.observe(web("healthy"), 35_000).state).toBe("pending");
		// New streak from 40 s: 60 s later at the earliest.
		expect(tracker.observe(web("unhealthy"), 40_000).state).toBe("pending");
		expect(tracker.observe(web("unhealthy"), 70_000).state).toBe("pending");
		expect(tracker.observe(web("starting"), 75_000).state).toBe("pending");
		expect(tracker.observe(web("unhealthy"), 80_000).state).toBe("pending");
		expect(tracker.observe(web("unhealthy"), 100_000).state).toBe("pending");
		// Restarted (new container start): the streak starts over too.
		expect(tracker.observe(web("unhealthy", 1), 140_000).state).toBe("pending");
		expect(tracker.observe(web("unhealthy", 1), 150_000).state).toBe("pending");
		expect(tracker.observe(web("unhealthy", 1), 200_000).state).toBe("failed");
	});

	it("still fails an unhealthy service that keeps restarting as a restart loop", () => {
		const tracker = new ReadinessTracker({ ...settings, stableMs: 0 });
		const up = [s("db", "running"), s("web", "running", 0)];
		tracker.observe(up, 0); // every service up: restarts count
		const sick = (restarts: number) => [
			s("db", "running"),
			s("web", "running", restarts, { health: "unhealthy" }),
		];
		expect(tracker.observe(sick(1), 5_000).state).toBe("pending");
		expect(tracker.observe(sick(2), 10_000).state).toBe("pending");
		expect(tracker.observe(sick(3), 15_000)).toMatchObject({
			state: "failed",
			failure: { kind: "restart_loop", service: "web", restarts: 3 },
		});
	});

	it("keeps the old immediate failure with a zero grace and one sample", () => {
		const tracker = new ReadinessTracker({
			...settings,
			unhealthyGraceMs: 0,
			unhealthySamples: 1,
		});
		expect(
			tracker.observe([s("web", "running", 0, { health: "unhealthy" })], 0)
				.state,
		).toBe("failed");
	});

	it("resets the window when a container disappears or appears", () => {
		const tracker = new ReadinessTracker({
			...settings,
			stableSamples: 2,
			stableMs: 5_000,
		});
		expect(
			tracker.observe([s("a", "running"), s("b", "running")], 0).state,
		).toBe("pending");
		// b removed mid-wait (inspect skipped it): a new window starts.
		expect(tracker.observe([s("a", "running")], 5_000).state).toBe("pending");
		expect(tracker.observe([s("a", "running")], 10_000).state).toBe("ready");
	});

	it("does not count first-boot restarts before every service was up", () => {
		// `auth` retries until the database accepts connections: 4 restarts
		// (above the limit of 3) while `db` is still starting.
		const tracker = new ReadinessTracker({
			...settings,
			stableMs: 0,
			stableSamples: 1,
		});
		const starting = s("db", "running", 0, { health: "starting" });
		const verdicts = [
			tracker.observe([starting, s("auth", "restarting", 1)], 0),
			tracker.observe([starting, s("auth", "restarting", 3)], 1),
			tracker.observe([starting, s("auth", "restarting", 5)], 2),
		];
		expect(verdicts.map((v) => v.state)).toEqual([
			"pending",
			"pending",
			"pending",
		]);
		expect(tracker.countingRestarts).toBe(false);
		const up = [
			s("db", "running", 0, { health: "healthy" }),
			s("auth", "running", 5),
		];
		expect(tracker.observe(up, 3).state).toBe("ready");
		expect(tracker.countingRestarts).toBe(true);
		// Reported, but not a warning: they happened while booting.
		expect(tracker.restarts()).toEqual([
			{ service: "auth", boot: 4, after: 0 },
		]);
		expect(tracker.restarted()).toEqual([]);
		// From here on the limit applies.
		expect(tracker.observe([up[0], s("auth", "running", 7)], 4).state).toBe(
			"ready",
		);
		expect(tracker.restarted()).toEqual([{ service: "auth", restarts: 2 }]);
		expect(
			tracker.observe([up[0], s("auth", "restarting", 8)], 5),
		).toMatchObject({
			state: "failed",
			failure: { kind: "restart_loop", service: "auth", restarts: 3 },
		});
	});

	it("fails a service that never comes up at the boot backstop (3× the limit)", () => {
		const tracker = new ReadinessTracker(settings);
		const db = s("db", "running");
		const at = (restarts: number) =>
			tracker.observe([db, s("functions", "restarting", restarts)], restarts);
		expect(at(0).state).toBe("pending");
		expect(at(8).state).toBe("pending");
		expect(at(9)).toMatchObject({
			state: "failed",
			failure: { kind: "restart_loop", service: "functions", restarts: 9 },
		});
	});
});
