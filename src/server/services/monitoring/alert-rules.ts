import { STOPPED_CONTAINER_STATES } from "#/config/metrics.ts";
import { diskPercent } from "./parsers";
import type { ContainerSample, ServerSample } from "./types";

type AlertSeverity = "warning" | "critical";

export interface AlertSettings {
	diskPercent: number;
	memoryPercent: number;
	hysteresisPercent: number;
	restartLoopCount: number;
	restartLoopWindowMs: number;
	unreachableFailures: number;
}

export interface RestartPoint {
	ts: number;
	count: number;
}

/** What monitoring expects of an app's containers (from its row). */
export interface AppExpectation {
	/** Its services should be up (status registry `live`). */
	live: boolean;
	/**
	 * A job works on the app (restart of a service, backup with the app
	 * stopped...): stopped services prove nothing, alerts keep their state.
	 */
	busy?: boolean;
	/** Services that may exit 0 and stay stopped (`oneShotServices`). */
	oneShot: ReadonlySet<string>;
	/** Services the owner stopped one by one (expected to be down). */
	stopped?: ReadonlySet<string>;
}

export interface AlertInput {
	now: number;
	/** Null when the tick failed or the collector didn't run. */
	server: ServerSample | null;
	containers: ContainerSample[] | null;
	/** Consecutive failed ticks (0 after a success). */
	failures: number;
	/** Restart counts per container within the restart-loop window. */
	restartHistory: ReadonlyMap<string, RestartPoint[]>;
	/**
	 * Containers whose proxy network repair monitoring gave up on (flap
	 * guard, apps/networks.ts) -> consecutive ticks they needed it.
	 */
	networkFlaps?: ReadonlyMap<string, number>;
	/** Apps of the server by id (rules about an app's own containers). */
	apps?: ReadonlyMap<string, AppExpectation>;
	settings: AlertSettings;
}

/**
 * fire: condition holds (open if not open). clear: condition is gone,
 * past the hysteresis band (resolve if open). hold: in between, keep the
 * current state.
 */
type Verdict = "fire" | "clear" | "hold";

export interface AlertEvaluation {
	/** What the alert is about (mount point, container name, "server"). */
	subject: string;
	verdict: Verdict;
	value?: number | null;
	threshold?: number | null;
	appId?: string | null;
}

/**
 * An alert rule. Adding one = one entry in `alertRules` (plus a label in
 * #/config/alert-rules.ts). A rule only runs on ticks that carry the data
 * it `needs`, so a failed tick never resolves disk/memory alerts. Open
 * alerts of a rule that ran but no longer report their subject (container
 * removed, mount gone) are resolved.
 */
export interface AlertRule {
	id: string;
	severity: AlertSeverity;
	needs: "server" | "containers" | "tick";
	evaluate(input: AlertInput): AlertEvaluation[];
}

/** Threshold with hysteresis: fire above, clear below threshold − band. */
export function thresholdVerdict(
	value: number | null,
	threshold: number,
	hysteresis: number,
): Verdict {
	if (value === null) return "hold";
	if (value > threshold) return "fire";
	if (value < threshold - hysteresis) return "clear";
	return "hold";
}

/** Restarts counted within the window (history is already pruned). */
export function restartsInWindow(points: RestartPoint[] | undefined): number {
	if (!points || points.length < 2) return 0;
	return Math.max(0, points[points.length - 1].count - points[0].count);
}

/**
 * Append this tick's restart counts and drop points older than the window.
 * A lower count means the container was recreated: its history restarts.
 */
export function updateRestartHistory(
	history: Map<string, RestartPoint[]>,
	containers: ContainerSample[],
	now: number,
	windowMs: number,
): void {
	const present = new Set<string>();
	for (const container of containers) {
		if (container.restartCount === null) continue;
		present.add(container.container);
		let points = history.get(container.container) ?? [];
		const last = points[points.length - 1];
		if (last && container.restartCount < last.count) points = [];
		points.push({ ts: now, count: container.restartCount });
		// Keep the newest point at or before the window start as the baseline.
		const start = now - windowMs;
		while (points.length > 1 && points[1].ts <= start) points.shift();
		history.set(container.container, points);
	}
	for (const name of [...history.keys()]) {
		if (!present.has(name)) history.delete(name);
	}
}

/**
 * Rebuild restart histories from stored samples (oldest first), so a
 * restart of Nitrobase neither hides an ongoing loop nor clears its alert.
 */
export function seedRestartHistory(
	rows: { container: string; ts: number; restartCount: number | null }[],
	now: number,
	windowMs: number,
): Map<string, RestartPoint[]> {
	const history = new Map<string, RestartPoint[]>();
	for (const row of rows) {
		if (row.restartCount === null) continue;
		let points = history.get(row.container) ?? [];
		const last = points[points.length - 1];
		if (last && row.restartCount < last.count) points = [];
		points.push({ ts: row.ts, count: row.restartCount });
		history.set(row.container, points);
	}
	const start = now - windowMs;
	for (const points of history.values()) {
		while (points.length > 1 && points[1].ts <= start) points.shift();
	}
	return history;
}

const percentOf = (used: number | null, total: number | null) =>
	used !== null && total ? Math.round((used / total) * 10_000) / 100 : null;

const diskUsageRule: AlertRule = {
	id: "disk_usage",
	severity: "warning",
	needs: "server",
	evaluate: ({ server, settings }) =>
		(server?.disks ?? []).map((disk) => {
			const value = diskPercent(disk);
			return {
				subject: disk.mount,
				value,
				threshold: settings.diskPercent,
				verdict: thresholdVerdict(
					value,
					settings.diskPercent,
					settings.hysteresisPercent,
				),
			};
		}),
};

const memoryUsageRule: AlertRule = {
	id: "memory_usage",
	severity: "warning",
	needs: "server",
	evaluate: ({ server, settings }) => {
		const value = percentOf(server?.memUsed ?? null, server?.memTotal ?? null);
		return [
			{
				subject: "memory",
				value,
				threshold: settings.memoryPercent,
				verdict: thresholdVerdict(
					value,
					settings.memoryPercent,
					settings.hysteresisPercent,
				),
			},
		];
	},
};

/** The history reaches back to the window start (quiet for a full window). */
function coversWindow(
	points: RestartPoint[] | undefined,
	now: number,
	windowMs: number,
): boolean {
	return !!points?.length && points[0].ts <= now - windowMs;
}

const restartLoopRule: AlertRule = {
	id: "restart_loop",
	severity: "critical",
	needs: "containers",
	evaluate: ({ containers, restartHistory, settings, now }) =>
		(containers ?? []).map((container) => {
			const points = restartHistory.get(container.container);
			const restarts = restartsInWindow(points);
			return {
				subject: container.container,
				appId: container.appId,
				value: restarts,
				threshold: settings.restartLoopCount,
				// Clear only after a whole quiet window: a short history (just
				// after boot or recreation) proves nothing.
				verdict:
					restarts >= settings.restartLoopCount
						? "fire"
						: restarts === 0 &&
								coversWindow(points, now, settings.restartLoopWindowMs)
							? "clear"
							: "hold",
			};
		}),
};

const unhealthyRule: AlertRule = {
	id: "container_unhealthy",
	severity: "critical",
	needs: "containers",
	evaluate: ({ containers }) =>
		(containers ?? []).map((container) => ({
			subject: container.container,
			appId: container.appId,
			// A stopped container keeps its last health: only running ones count.
			verdict:
				container.state !== "running"
					? "clear"
					: container.health === "unhealthy"
						? "fire"
						: container.health === "starting"
							? "hold"
							: "clear",
		})),
};

/**
 * A container of an app that should be running is stopped (BUG-015): a
 * reboot of the host left it exited, or it crashed under a policy that
 * does not restart it. Not while the app is stopped or being changed
 * (status not `live`), and not for a one-shot service that exited 0.
 */
function stoppedUnexpectedly(
	container: ContainerSample,
	app: AppExpectation | undefined,
): boolean {
	if (!app?.live) return false;
	if (!STOPPED_CONTAINER_STATES.has(container.state ?? "")) return false;
	if (container.service && app.stopped?.has(container.service)) return false;
	const oneShot = container.service
		? app.oneShot.has(container.service)
		: false;
	return !(oneShot && container.exitCode === 0);
}

const exitedRule: AlertRule = {
	id: "container_exited",
	severity: "critical",
	needs: "containers",
	evaluate: ({ containers, apps }) =>
		(containers ?? []).flatMap((container) => {
			// Only an app's own containers: nothing tells what others expect.
			const app = container.appId ? apps?.get(container.appId) : undefined;
			if (!app) return [];
			return [
				{
					subject: container.container,
					appId: container.appId,
					value: container.exitCode ?? null,
					verdict: app.busy
						? "hold"
						: stoppedUnexpectedly(container, app)
							? "fire"
							: "clear",
				},
			];
		}),
};

/** M6: the kernel killed a process of the container for memory. */
const oomRule: AlertRule = {
	id: "container_oom",
	severity: "critical",
	needs: "containers",
	evaluate: ({ containers }) =>
		(containers ?? []).map((container) => ({
			subject: container.container,
			appId: container.appId,
			// Docker clears the flag when the container starts again.
			verdict: container.oomKilled ? "fire" : "clear",
		})),
};

/** BUG-006 self-heal gave up: the container keeps leaving the proxy network. */
const networkFlapRule: AlertRule = {
	id: "network_flap",
	severity: "warning",
	needs: "containers",
	evaluate: ({ containers, networkFlaps }) =>
		(containers ?? []).map((container) => {
			const ticks = networkFlaps?.get(container.container);
			return {
				subject: container.container,
				appId: container.appId,
				value: ticks ?? null,
				verdict: ticks ? "fire" : "clear",
			};
		}),
};

const unreachableRule: AlertRule = {
	id: "server_unreachable",
	severity: "critical",
	needs: "tick",
	evaluate: ({ failures, settings }) => [
		{
			subject: "server",
			value: failures,
			threshold: settings.unreachableFailures,
			verdict:
				failures >= settings.unreachableFailures
					? "fire"
					: failures === 0
						? "clear"
						: "hold",
		},
	],
};

/** Rule registry (order = evaluation order). */
export const alertRules: AlertRule[] = [
	diskUsageRule,
	memoryUsageRule,
	restartLoopRule,
	unhealthyRule,
	exitedRule,
	oomRule,
	networkFlapRule,
	unreachableRule,
];

/** Rules whose data is present in this tick, with their evaluations. */
export function evaluateRules(
	input: AlertInput,
): Map<string, AlertEvaluation[]> {
	const out = new Map<string, AlertEvaluation[]>();
	for (const rule of alertRules) {
		if (rule.needs === "server" && !input.server) continue;
		if (rule.needs === "containers" && !input.containers) continue;
		out.set(rule.id, rule.evaluate(input));
	}
	return out;
}

export interface OpenAlertKey {
	id: string;
	rule: string;
	subject: string;
}

export interface AlertPlan<T extends OpenAlertKey> {
	/** New alerts to open. */
	open: (AlertEvaluation & { rule: string })[];
	/** Open alerts whose condition still holds (refresh lastSeen/value). */
	seen: { alert: T; evaluation: AlertEvaluation }[];
	/** Open alerts to resolve (cleared, or subject gone). */
	resolve: T[];
}

/** Combine this tick's evaluations with the currently open alerts. */
export function planAlertChanges<T extends OpenAlertKey>(
	openAlerts: T[],
	evaluations: Map<string, AlertEvaluation[]>,
): AlertPlan<T> {
	const plan: AlertPlan<T> = { open: [], seen: [], resolve: [] };
	const openByKey = new Map(
		openAlerts.map((alert) => [`${alert.rule}\u0000${alert.subject}`, alert]),
	);
	for (const [rule, results] of evaluations) {
		const reported = new Set<string>();
		for (const evaluation of results) {
			const key = `${rule}\u0000${evaluation.subject}`;
			reported.add(key);
			const existing = openByKey.get(key);
			if (evaluation.verdict === "fire") {
				if (existing) plan.seen.push({ alert: existing, evaluation });
				else plan.open.push({ ...evaluation, rule });
			} else if (evaluation.verdict === "clear" && existing) {
				plan.resolve.push(existing);
			} else if (evaluation.verdict === "hold" && existing) {
				plan.seen.push({ alert: existing, evaluation });
			}
		}
		for (const alert of openAlerts) {
			if (
				alert.rule === rule &&
				!reported.has(`${alert.rule}\u0000${alert.subject}`)
			) {
				plan.resolve.push(alert);
			}
		}
	}
	return plan;
}
