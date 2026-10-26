import { describe, expect, it } from "vitest";
import {
	type AlertInput,
	alertRules,
	evaluateRules,
	planAlertChanges,
	type RestartPoint,
	restartsInWindow,
	seedRestartHistory,
	thresholdVerdict,
	updateRestartHistory,
} from "./alert-rules";
import type { ContainerSample, ServerSample } from "./types";

const settings = {
	diskPercent: 85,
	memoryPercent: 90,
	hysteresisPercent: 5,
	restartLoopCount: 3,
	restartLoopWindowMs: 10 * 60_000,
	unreachableFailures: 3,
};

const server = (overrides: Partial<ServerSample> = {}): ServerSample => ({
	ts: 0,
	cpuPercent: 10,
	load1: 0,
	load5: 0,
	load15: 0,
	memUsed: 50,
	memTotal: 100,
	swapUsed: 0,
	swapTotal: 0,
	netRxBps: 0,
	netTxBps: 0,
	uptimeSeconds: 1,
	disks: [{ mount: "/", fs: "ext4", used: 50, avail: 50, total: 100 }],
	...overrides,
});

const container = (
	name: string,
	overrides: Partial<ContainerSample> = {},
): ContainerSample => ({
	ts: 0,
	container: name,
	appLabel: "app-1",
	project: null,
	appId: "app-1",
	service: "web",
	state: "running",
	health: null,
	restartCount: 0,
	cpuPercent: 0,
	memUsed: 0,
	memLimit: 0,
	netRxBps: 0,
	netTxBps: 0,
	...overrides,
});

const input = (overrides: Partial<AlertInput> = {}): AlertInput => ({
	now: 0,
	server: server(),
	containers: [],
	failures: 0,
	restartHistory: new Map(),
	settings,
	...overrides,
});

const open = (rule: string, subject: string, id = `${rule}:${subject}`) => ({
	id,
	rule,
	subject,
});

describe("thresholdVerdict (hysteresis)", () => {
	it("fires above, clears below threshold minus band, holds between", () => {
		expect(thresholdVerdict(86, 85, 5)).toBe("fire");
		expect(thresholdVerdict(85, 85, 5)).toBe("hold");
		expect(thresholdVerdict(82, 85, 5)).toBe("hold");
		expect(thresholdVerdict(79.9, 85, 5)).toBe("clear");
		expect(thresholdVerdict(null, 85, 5)).toBe("hold");
	});
});

describe("disk and memory rules", () => {
	it("opens per mount, keeps it in the band, resolves below it", () => {
		const full = server({
			disks: [
				{ mount: "/", fs: "ext4", used: 90, avail: 10, total: 100 },
				{ mount: "/data", fs: "xfs", used: 10, avail: 90, total: 100 },
			],
		});
		let plan = planAlertChanges(
			[] as ReturnType<typeof open>[],
			evaluateRules(input({ server: full })),
		);
		expect(
			plan.open.map((item) => [item.rule, item.subject, item.value]),
		).toEqual([["disk_usage", "/", 90]]);

		const alert = open("disk_usage", "/");
		const band = server({
			disks: [{ mount: "/", fs: "ext4", used: 83, avail: 17, total: 100 }],
		});
		plan = planAlertChanges([alert], evaluateRules(input({ server: band })));
		expect(plan.resolve).toEqual([]);
		expect(plan.seen.map((item) => item.alert.id)).toEqual(["disk_usage:/"]);

		const low = server({
			disks: [{ mount: "/", fs: "ext4", used: 70, avail: 30, total: 100 }],
		});
		plan = planAlertChanges([alert], evaluateRules(input({ server: low })));
		expect(plan.resolve).toEqual([alert]);
	});

	it("resolves a disk alert whose mount disappeared", () => {
		const alert = open("disk_usage", "/mnt/old");
		const plan = planAlertChanges([alert], evaluateRules(input()));
		expect(plan.resolve).toEqual([alert]);
	});

	it("memory fires above its own threshold", () => {
		const plan = planAlertChanges(
			[],
			evaluateRules(input({ server: server({ memUsed: 95, memTotal: 100 }) })),
		);
		expect(plan.open.map((item) => item.rule)).toEqual(["memory_usage"]);
	});

	it("a failed tick never resolves server/container alerts", () => {
		const disk = open("disk_usage", "/");
		const loop = open("restart_loop", "app-web");
		const plan = planAlertChanges(
			[disk, loop],
			evaluateRules(input({ server: null, containers: null, failures: 1 })),
		);
		expect(plan.resolve).toEqual([]);
		expect(plan.open).toEqual([]);
	});
});

describe("restart loop", () => {
	const window = settings.restartLoopWindowMs;

	it("tracks counts inside the window and resets on recreation", () => {
		const history = new Map<string, RestartPoint[]>();
		updateRestartHistory(
			history,
			[container("c", { restartCount: 0 })],
			0,
			window,
		);
		updateRestartHistory(
			history,
			[container("c", { restartCount: 2 })],
			60_000,
			window,
		);
		updateRestartHistory(
			history,
			[container("c", { restartCount: 4 })],
			120_000,
			window,
		);
		expect(restartsInWindow(history.get("c"))).toBe(4);

		// Ten minutes of no restarts: the baseline moves up to the last count.
		updateRestartHistory(
			history,
			[container("c", { restartCount: 4 })],
			720_000,
			window,
		);
		updateRestartHistory(
			history,
			[container("c", { restartCount: 4 })],
			780_000,
			window,
		);
		expect(restartsInWindow(history.get("c"))).toBe(0);

		// Recreated container (count went down): history starts over.
		updateRestartHistory(
			history,
			[container("c", { restartCount: 1 })],
			840_000,
			window,
		);
		expect(history.get("c")).toEqual([{ ts: 840_000, count: 1 }]);

		// Removed containers are forgotten.
		updateRestartHistory(history, [], 900_000, window);
		expect(history.has("c")).toBe(false);
	});

	it("fires at N restarts in the window, holds while restarting, clears when quiet", () => {
		const containers = [container("app-web")];
		const evaluate = (points: RestartPoint[]) =>
			evaluateRules(
				input({
					containers,
					restartHistory: new Map([["app-web", points]]),
				}),
			);
		let plan = planAlertChanges(
			[] as ReturnType<typeof open>[],
			evaluate([
				{ ts: 0, count: 0 },
				{ ts: 1, count: 3 },
			]),
		);
		expect(plan.open).toMatchObject([
			{ rule: "restart_loop", subject: "app-web", appId: "app-1", value: 3 },
		]);
		const alert = open("restart_loop", "app-web");
		plan = planAlertChanges(
			[alert],
			evaluate([
				{ ts: 0, count: 3 },
				{ ts: 1, count: 4 },
			]),
		);
		expect(plan.resolve).toEqual([]);
		// Too short a history (e.g. just after boot): keep it open.
		plan = planAlertChanges([alert], evaluate([{ ts: 0, count: 4 }]));
		expect(plan.resolve).toEqual([]);
		// Quiet for a whole window: resolve.
		plan = planAlertChanges(
			[alert],
			evaluateRules(
				input({
					now: 20 * 60_000,
					containers,
					restartHistory: new Map([
						[
							"app-web",
							[
								{ ts: 5 * 60_000, count: 4 },
								{ ts: 20 * 60_000, count: 4 },
							],
						],
					]),
				}),
			),
		);
		expect(plan.resolve).toEqual([alert]);
	});
});

describe("seedRestartHistory", () => {
	it("rebuilds a window-long baseline from stored samples", () => {
		const minute = 60_000;
		const history = seedRestartHistory(
			[
				{ container: "c", ts: 0, restartCount: 1 },
				{ container: "c", ts: 5 * minute, restartCount: 2 },
				{ container: "c", ts: 12 * minute, restartCount: 5 },
				{ container: "d", ts: 1 * minute, restartCount: 9 },
				{ container: "d", ts: 2 * minute, restartCount: 0 },
				{ container: "e", ts: 3 * minute, restartCount: null },
			],
			15 * minute,
			10 * minute,
		);
		// Baseline = newest point at or before the window start (5 min).
		expect(history.get("c")).toEqual([
			{ ts: 5 * minute, count: 2 },
			{ ts: 12 * minute, count: 5 },
		]);
		expect(restartsInWindow(history.get("c"))).toBe(3);
		// Count went down: recreated, history restarts.
		expect(history.get("d")).toEqual([{ ts: 2 * minute, count: 0 }]);
		expect(history.has("e")).toBe(false);
	});
});

describe("unhealthy and unreachable", () => {
	it("unhealthy fires, starting holds, healthy clears", () => {
		const alert = open("container_unhealthy", "c");
		const run = (health: string | null, openAlerts = [alert]) =>
			planAlertChanges(
				openAlerts,
				evaluateRules(input({ containers: [container("c", { health })] })),
			);
		expect(run("unhealthy", []).open.map((item) => item.subject)).toEqual([
			"c",
		]);
		expect(run("starting").resolve).toEqual([]);
		expect(run("healthy").resolve).toEqual([alert]);
		// Stopped containers keep their last health; they don't count.
		expect(
			planAlertChanges(
				[] as ReturnType<typeof open>[],
				evaluateRules(
					input({
						containers: [
							container("c", { state: "exited", health: "unhealthy" }),
						],
					}),
				),
			).open,
		).toEqual([]);
		expect(run(null).resolve).toEqual([alert]);
	});

	it("unreachable needs N consecutive failures and clears on success", () => {
		const failing = (failures: number, openAlerts: ReturnType<typeof open>[]) =>
			planAlertChanges(
				openAlerts,
				evaluateRules(input({ server: null, containers: null, failures })),
			);
		expect(failing(2, []).open).toEqual([]);
		expect(failing(3, []).open.map((item) => item.rule)).toEqual([
			"server_unreachable",
		]);
		const alert = open("server_unreachable", "server");
		expect(failing(1, [alert]).resolve).toEqual([]);
		expect(failing(0, [alert]).resolve).toEqual([alert]);
	});

	it("every registered rule has a unique id", () => {
		const ids = alertRules.map((rule) => rule.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("network flap alert", () => {
	it("fires for containers the proxy network self-heal gave up on", () => {
		const evaluations = evaluateRules(
			input({
				containers: [container("app-web"), container("app-db")],
				networkFlaps: new Map([["app-web", 4]]),
			}),
		).get("network_flap");
		expect(evaluations).toEqual([
			{ subject: "app-web", appId: "app-1", value: 4, verdict: "fire" },
			{ subject: "app-db", appId: "app-1", value: null, verdict: "clear" },
		]);
	});
});

describe("stopped service alert (BUG-015)", () => {
	const live = (oneShot: string[] = []) =>
		new Map([["app-1", { live: true, oneShot: new Set(oneShot) }]]);
	const exited = (exitCode: number, service = "postgresql", state = "exited") =>
		container(`aw-${service}`, { service, state, exitCode });
	const verdicts = (
		containers: ContainerSample[],
		apps: AlertInput["apps"] = live(["migrate"]),
	) =>
		evaluateRules(input({ containers, apps }))
			.get("container_exited")
			?.map((item) => [item.subject, item.verdict, item.value]);

	it("fires for a service of a running app that stopped", () => {
		// A host reboot stops postgres cleanly (0): still unexpected.
		expect(verdicts([exited(0), exited(255, "redis")])).toEqual([
			["aw-postgresql", "fire", 0],
			["aw-redis", "fire", 255],
		]);
		expect(verdicts([exited(1, "browser", "dead")])).toEqual([
			["aw-browser", "fire", 1],
		]);
		expect(verdicts([container("aw-postgresql", { exitCode: 0 })])).toEqual([
			["aw-postgresql", "clear", 0],
		]);
	});

	it("leaves one-shot jobs that finished alone, not failed ones", () => {
		expect(verdicts([exited(0, "migrate"), exited(1, "migrate")])).toEqual([
			["aw-migrate", "clear", 0],
			["aw-migrate", "fire", 1],
		]);
	});

	it("does not fire while the owner stopped the app or a job changes it", () => {
		const stopped = new Map([
			["app-1", { live: false, oneShot: new Set<string>() }],
		]);
		expect(verdicts([exited(0)], stopped)).toEqual([
			["aw-postgresql", "clear", 0],
		]);
	});

	it("keeps its state while a job works on the app", () => {
		const busy = new Map([
			["app-1", { live: true, busy: true, oneShot: new Set<string>() }],
		]);
		expect(verdicts([exited(0)], busy)).toEqual([["aw-postgresql", "hold", 0]]);
	});

	it("ignores containers of no app (nothing tells what they expect)", () => {
		expect(
			verdicts([
				{ ...exited(1), appId: null },
				{ ...exited(1), appId: "x" },
			]),
		).toEqual([]);
		expect(verdicts([exited(1)], new Map())).toEqual([]);
	});

	it("resolves once the service runs again", () => {
		const alert = open("container_exited", "aw-postgresql");
		const plan = planAlertChanges(
			[alert],
			evaluateRules(
				input({ containers: [container("aw-postgresql")], apps: live() }),
			),
		);
		expect(plan.resolve).toEqual([alert]);
	});
});
