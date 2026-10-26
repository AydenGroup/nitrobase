import { describe, expect, it } from "vitest";
import { createIdleHooks, pendingRoutesListener } from "./idle-hooks";

type RoutesOutcome = "write" | "fail" | "not-deployed";

/**
 * Simulates the job runner: one lock per server, idle hooks on release,
 * apps flagged `routesPending` when their routes job can't start.
 */
function simulation(outcomes: Record<string, RoutesOutcome> = {}) {
	const hooks = createIdleHooks();
	const locks = new Set<string>();
	const pending = new Map<string, { serverId: string; teamId: string }>();
	const written: string[] = [];
	let jobs = 0;
	let clock = 0;

	const runJob = async (serverId: string, work: () => Promise<void>) => {
		if (locks.has(serverId)) throw new Error("SERVER_BUSY");
		locks.add(serverId);
		jobs++;
		try {
			await work();
		} finally {
			locks.delete(serverId);
			await hooks.notify(serverId);
		}
	};
	/** Mirrors runRoutes: write clears the flag, not-deployed clears it, failure leaves it. */
	const startRoutes = (appId: string) =>
		runJob("srv", async () => {
			const outcome = outcomes[appId] ?? "write";
			if (outcome === "write") {
				written.push(appId);
				pending.delete(appId);
			} else if (outcome === "not-deployed") {
				pending.delete(appId);
			}
		});
	hooks.on(
		pendingRoutesListener({
			attempts: new Map(),
			backoffMs: 1000,
			now: () => clock,
			listPending: async (serverId) =>
				[...pending.entries()]
					.filter(([, value]) => value.serverId === serverId)
					.map(([appId, value]) => ({ appId, teamId: value.teamId })),
			startRoutes: (appId) => startRoutes(appId),
		}),
	);
	/** addDomain: try the routes job, flag the app when busy. */
	const addDomain = async (appId: string) => {
		try {
			await startRoutes(appId);
		} catch {
			pending.set(appId, { serverId: "srv", teamId: "u" });
		}
	};
	const blockingJob = () => {
		let release = () => {};
		const done = runJob(
			"srv",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		return { release: () => release(), done };
	};
	return {
		runJob,
		addDomain,
		blockingJob,
		written,
		pending,
		jobs: () => jobs,
		tick: (ms: number) => {
			clock += ms;
		},
	};
}

describe("pending routes", () => {
	it("applies a domain added during another app's deploy once the server is idle", async () => {
		const sim = simulation();
		const deploy = sim.blockingJob();
		await sim.addDomain("app-b");
		expect(sim.written).toEqual([]);
		expect(sim.pending.has("app-b")).toBe(true);

		deploy.release();
		await deploy.done;
		expect(sim.written).toEqual(["app-b"]);
		expect(sim.pending.size).toBe(0);
	});

	it("drains several pending apps one after another", async () => {
		const sim = simulation();
		const deploy = sim.blockingJob();
		await sim.addDomain("a");
		await sim.addDomain("b");
		deploy.release();
		await deploy.done;
		expect(sim.written.sort()).toEqual(["a", "b"]);
	});

	it("never loops when the routes job fails: one automatic attempt per backoff", async () => {
		const sim = simulation({ broken: "fail" });
		const deploy = sim.blockingJob();
		await sim.addDomain("broken");
		deploy.release();
		await deploy.done;
		// deploy + one automatic routes attempt, then the listener backs off.
		expect(sim.jobs()).toBe(2);
		expect(sim.pending.has("broken")).toBe(true);

		// Unrelated jobs within the backoff window don't retry it.
		await sim.runJob("srv", async () => {});
		expect(sim.jobs()).toBe(3);

		// After the backoff, the next release retries once more.
		sim.tick(1000);
		await sim.runJob("srv", async () => {});
		expect(sim.jobs()).toBe(5);
	});

	it("a failing app does not block other pending apps", async () => {
		const sim = simulation({ broken: "fail" });
		const deploy = sim.blockingJob();
		await sim.addDomain("broken");
		await sim.addDomain("ok");
		deploy.release();
		await deploy.done;
		expect(sim.written).toEqual(["ok"]);
	});

	it("clears the flag for apps that are not deployed yet", async () => {
		const sim = simulation({ fresh: "not-deployed" });
		const deploy = sim.blockingJob();
		await sim.addDomain("fresh");
		deploy.release();
		await deploy.done;
		expect(sim.pending.size).toBe(0);
		expect(sim.jobs()).toBe(2);
	});

	it("isolates listener errors", async () => {
		const hooks = createIdleHooks();
		let called = false;
		hooks.on(() => {
			throw new Error("boom");
		});
		hooks.on(() => {
			called = true;
		});
		await hooks.notify("srv");
		expect(called).toBe(true);
	});
});
