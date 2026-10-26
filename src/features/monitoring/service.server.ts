import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import {
	isAppBusy,
	isServerBusy,
} from "#/features/deployments/deployments.server.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import {
	getExecutor,
	listReadyServers,
} from "#/features/servers/servers.server.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { pluginCollectors } from "#/plugins/server.ts";
import {
	guardNetworkRepairs,
	type NetworkRepair,
	networkRepairScript,
	parseNetworkRepairs,
} from "#/server/services/apps/networks.ts";
import { audit } from "#/server/services/audit.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import { onEvent } from "#/server/services/events/bus.ts";
import type { Executor } from "#/server/services/executor.ts";
import { currentInstanceId } from "#/server/services/instance-state.ts";
import {
	type AlertSettings,
	type AppExpectation,
	evaluateRules,
	planAlertChanges,
	type RestartPoint,
	seedRestartHistory,
	updateRestartHistory,
} from "#/server/services/monitoring/alert-rules.ts";
import { createBatchWriter } from "#/server/services/monitoring/batch.ts";
import {
	type CollectorContext,
	type CollectorSettings,
	type MetricCollector,
	metricCollectors,
} from "#/server/services/monitoring/collectors.ts";
import {
	combineCollectorCommands,
	splitCollectorOutput,
} from "#/server/services/monitoring/commands.ts";
import { appExpectations } from "#/server/services/monitoring/expectations.ts";
import {
	mapContainerApps,
	nextDelay,
} from "#/server/services/monitoring/loop.ts";
import { diskPercent } from "#/server/services/monitoring/parsers.ts";
import type {
	ContainerSample,
	TickSamples,
} from "#/server/services/monitoring/types.ts";
import { schedule, unschedule } from "#/server/services/scheduler.ts";
import { oneShotServicesOf } from "#/server/services/templates/restart.ts";
import { AppError, internalError } from "#/utils/error.ts";
import {
	applyAlertPlan,
	loadOpenAlerts,
	type OpenAlertRow,
} from "./alerts.server";
import {
	type ContainerSampleRow,
	insertContainerSamples,
	insertServerSamples,
	latestContainerSamples,
	latestServerSamples,
	pruneMetrics,
	recentRestartCounts,
	resolutionSettings,
	rollupMetrics,
	type ServerSampleRow,
} from "./monitoring.server";
import type { LiveTick, MonitorStatus, ServerHealthSummary } from "./schema";

/**
 * Monitoring service. One collection loop per Ready server, each with a
 * long-lived executor (one SSH connection reused across ticks; a tick runs
 * ONE remote command for all collectors). Loops never take the job server
 * lock, so collection can't block deploys and vice versa.
 *
 * Assumes a single Nitrobase instance (like the job runner and scheduler):
 * loops, the live hub and the alert state live in this process. A second
 * instance would collect twice and race on alert rows (the partial unique
 * index keeps at most one open alert per subject).
 */

interface Loop {
	serverId: string;
	teamId: string;
	/** Hash of the connection settings; a change restarts the loop. */
	fingerprint: string;
	server: ServerRow;
	executor: Executor | null;
	timer: ReturnType<typeof setTimeout> | null;
	stopped: boolean;
	failures: number;
	collectorState: Map<string, unknown>;
	restartHistory: Map<string, RestartPoint[]> | null;
	openAlerts: OpenAlertRow[] | null;
	/** Proxy network repair streaks and the containers given up on. */
	networkStreak?: Map<string, number>;
	networkFlaps?: Map<string, number>;
	/** One-shot services per app, by digest of its deployed compose file. */
	oneShot?: Map<string, { digest: string | null; services: Set<string> }>;
	/** Collect again right away with a fresh connection. */
	poke: boolean;
}

interface HubEntry {
	ring: LiveTick[];
	status: MonitorStatus;
	subscribers: Set<(tick: LiveTick) => void>;
}

interface MonitoringState {
	loops: Map<string, Loop>;
	hub: Map<string, HubEntry>;
	writers: {
		server: ReturnType<typeof createBatchWriter<ServerSampleRow>>;
		container: ReturnType<typeof createBatchWriter<ContainerSampleRow>>;
	} | null;
	reconciling: boolean;
}

// On globalThis so dev HMR reloads reuse loops instead of duplicating them.
const globalMonitoring = globalThis as typeof globalThis & {
	__nitrobaseMonitoring?: MonitoringState;
};
globalMonitoring.__nitrobaseMonitoring ??= {
	loops: new Map(),
	hub: new Map(),
	writers: null,
	reconciling: false,
};
const state: MonitoringState = globalMonitoring.__nitrobaseMonitoring;

function writers() {
	if (state.writers) return state.writers;
	const config = getConfig();
	const onError = (error: unknown) =>
		console.error("[monitoring] sample write failed", error);
	state.writers = {
		server: createBatchWriter({
			write: insertServerSamples,
			maxRows: config.MONITORING_FLUSH_BATCH_SIZE,
			intervalMs: config.MONITORING_FLUSH_INTERVAL_MS,
			onError,
		}),
		container: createBatchWriter({
			write: insertContainerSamples,
			maxRows: config.MONITORING_FLUSH_BATCH_SIZE,
			intervalMs: config.MONITORING_FLUSH_INTERVAL_MS,
			onError,
		}),
	};
	return state.writers;
}

function hubEntry(serverId: string): HubEntry {
	let entry = state.hub.get(serverId);
	if (!entry) {
		entry = { ring: [], status: "inactive", subscribers: new Set() };
		state.hub.set(serverId, entry);
	}
	return entry;
}

function setStatus(serverId: string, status: MonitorStatus): void {
	hubEntry(serverId).status = status;
}

function publish(serverId: string, tick: LiveTick): void {
	const entry = hubEntry(serverId);
	entry.ring.push(tick);
	const max = getConfig().MONITORING_LIVE_POINTS;
	if (entry.ring.length > max) entry.ring.splice(0, entry.ring.length - max);
	for (const subscriber of [...entry.subscribers]) {
		try {
			subscriber(tick);
		} catch (error) {
			console.error("[monitoring] subscriber failed", error);
		}
	}
}

/** Live ring buffer and loop status of a server. */
export function liveSnapshot(serverId: string): {
	status: MonitorStatus;
	ticks: LiveTick[];
} {
	const entry = state.hub.get(serverId);
	return {
		status: entry?.status ?? "inactive",
		ticks: entry ? [...entry.ring] : [],
	};
}

/** Subscribe to a server's ticks; returns the unsubscribe function. */
export function subscribeTicks(
	serverId: string,
	listener: (tick: LiveTick) => void,
): () => void {
	const entry = hubEntry(serverId);
	entry.subscribers.add(listener);
	return () => {
		entry.subscribers.delete(listener);
	};
}

function monitorStatus(serverId: string): MonitorStatus {
	return state.hub.get(serverId)?.status ?? "inactive";
}

function collectorSettings(config = getConfig()): CollectorSettings {
	return {
		pseudoFs: config.MONITORING_PSEUDO_FS,
		ignoreMountPrefixes: config.MONITORING_IGNORE_MOUNT_PREFIXES,
		ignoreMounts: config.MONITORING_IGNORE_MOUNTS,
		ignoreNetPrefixes: config.MONITORING_IGNORE_NET_PREFIXES,
		proxyNetwork: config.NITROBASE_NETWORK,
		instanceId: currentInstanceId(),
	};
}

function alertSettings(config = getConfig()): AlertSettings {
	return {
		diskPercent: config.ALERT_DISK_PERCENT,
		memoryPercent: config.ALERT_MEMORY_PERCENT,
		hysteresisPercent: config.ALERT_HYSTERESIS_PERCENT,
		restartLoopCount: config.ALERT_RESTART_LOOP_COUNT,
		restartLoopWindowMs: config.ALERT_RESTART_LOOP_WINDOW_MINUTES * 60_000,
		unreachableFailures: config.ALERT_UNREACHABLE_FAILURES,
	};
}

function connectionFingerprint(server: ServerRow): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				server.isDefault,
				server.host,
				server.port,
				server.username,
				server.authMethod,
				server.sshKeyId,
				server.passwordEncrypted,
				server.hostKeyFingerprint,
			]),
		)
		.digest("hex");
}

function collectorsFor(ctx: CollectorContext): MetricCollector[] {
	return [...metricCollectors, ...pluginCollectors(ctx.templateIds)].filter(
		(collector) => collector.appliesTo?.(ctx) ?? true,
	);
}

/**
 * One-shot services of the server's apps (alert rules), from their
 * deployed compose files, parsed again only when a file's digest changes.
 */
async function refreshOneShot(
	loop: Loop,
	rows: { id: string; composeDigest: string | null }[],
): Promise<void> {
	loop.oneShot ??= new Map();
	const cache = loop.oneShot;
	const stale = rows.filter(
		(row) =>
			!cache.has(row.id) || cache.get(row.id)?.digest !== row.composeDigest,
	);
	if (stale.length > 0) {
		const composes = await db
			.select({ id: apps.id, compose: apps.composeDeployed })
			.from(apps)
			.where(
				inArray(
					apps.id,
					stale.map((row) => row.id),
				),
			);
		for (const row of stale) {
			const compose = composes.find((item) => item.id === row.id)?.compose;
			cache.set(row.id, {
				digest: row.composeDigest,
				services: oneShotServicesOf(compose ?? null),
			});
		}
	}
	const ids = new Set(rows.map((row) => row.id));
	for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
}

/** Expectations from the apps' rows as they are now (after the tick). */
async function currentExpectations(
	loop: Loop,
): Promise<Map<string, AppExpectation>> {
	const rows = await db
		.select({
			id: apps.id,
			status: apps.status,
			stoppedServices: sql<string[] | null>`${apps.inputs}->'stoppedServices'`,
		})
		.from(apps)
		.where(eq(apps.serverId, loop.serverId));
	return appExpectations(
		rows,
		new Map(
			[...(loop.oneShot ?? new Map()).entries()].map(([id, entry]) => [
				id,
				entry.services,
			]),
		),
		(appId) => isAppBusy(loop.serverId, appId),
	);
}

async function collect(loop: Loop): Promise<TickSamples> {
	const config = getConfig();
	const now = Date.now();
	const appRows = await db
		.select({
			id: apps.id,
			templateId: apps.templateId,
			folder: apps.folder,
			composeDigest: sql<string | null>`md5(${apps.composeDeployed})`,
		})
		.from(apps)
		.where(eq(apps.serverId, loop.serverId));
	await refreshOneShot(loop, appRows);
	const ctx: CollectorContext = {
		now,
		settings: collectorSettings(config),
		templateIds: new Set(appRows.map((app) => app.templateId)),
	};
	const collectors = collectorsFor(ctx);
	const command = combineCollectorCommands(
		collectors.map((collector) => ({
			id: collector.id,
			command: collector.command(ctx),
		})),
	);
	if (!loop.executor) {
		const executor = await getExecutor(loop.server);
		// stopLoop ran meanwhile: it could not close this one.
		if (loop.stopped) {
			executor.close();
			throw internalError("Monitoring stopped");
		}
		loop.executor = executor;
	}
	const result = await loop.executor.exec(command, {
		timeoutMs: config.MONITORING_COMMAND_TIMEOUT_MS,
	});
	const outputs = splitCollectorOutput(result.stdout);
	if (outputs.size === 0) {
		throw new AppError("MONITORING_NO_OUTPUT", { code: result.exitCode ?? -1 });
	}
	const samples: TickSamples = { server: null, containers: null };
	for (const collector of collectors) {
		const output = outputs.get(collector.id);
		if (output === undefined) continue;
		try {
			const collected = collector.collect(
				output,
				loop.collectorState.get(collector.id),
				ctx,
			);
			loop.collectorState.set(collector.id, collected.state);
			samples.server ??= collected.samples.server ?? null;
			if (collected.samples.networkRepairs) {
				samples.networkRepairs = [
					...(samples.networkRepairs ?? []),
					...collected.samples.networkRepairs,
				];
			}
			if (collected.samples.containers) {
				samples.containers = [
					...(samples.containers ?? []),
					...collected.samples.containers,
				];
			}
		} catch (error) {
			console.warn(
				`[monitoring] collector ${collector.id} failed on ${loop.serverId}:`,
				error instanceof Error ? error.message : error,
			);
		}
	}
	if (!samples.server && !samples.containers) {
		throw new AppError("MONITORING_NO_DATA");
	}
	if (samples.containers) {
		samples.containers = mapContainerApps(
			samples.containers,
			new Map(appRows.map((app) => [app.id, app.folder])),
		);
	}
	return samples;
}

async function evaluateAlerts(
	loop: Loop,
	samples: TickSamples,
	now: number,
): Promise<void> {
	const settings = alertSettings();
	// Window-long baseline from stored samples (survives a panel restart).
	loop.restartHistory ??= seedRestartHistory(
		await recentRestartCounts(
			loop.serverId,
			new Date(now - 2 * settings.restartLoopWindowMs),
		),
		now,
		settings.restartLoopWindowMs,
	);
	if (samples.containers) {
		updateRestartHistory(
			loop.restartHistory,
			samples.containers,
			now,
			settings.restartLoopWindowMs,
		);
	}
	loop.openAlerts ??= await loadOpenAlerts(loop.serverId);
	const evaluations = evaluateRules({
		now,
		server: samples.server,
		containers: samples.containers,
		failures: loop.failures,
		restartHistory: loop.restartHistory,
		networkFlaps: loop.networkFlaps,
		apps: samples.containers ? await currentExpectations(loop) : undefined,
		settings,
	});
	const plan = planAlertChanges(loop.openAlerts, evaluations);
	loop.openAlerts = await applyAlertPlan(
		{ id: loop.serverId, teamId: loop.teamId },
		loop.openAlerts,
		plan,
		new Date(now),
	);
}

function stripLabel({
	appLabel: _label,
	project: _project,
	...rest
}: ContainerSample) {
	return rest;
}

/**
 * Self-heal of the proxy network (BUG-006): a routed container of this
 * panel found off it is attached again (e.g. after a manual `docker
 * compose up`); one registered there under its service name (a compose
 * file of an earlier version recreated it) is re-attached by container
 * name only. Costs nothing when nothing is wrong (the tick's inspect
 * already carries the state).
 */
async function repairNetworks(
	loop: Loop,
	repairs: NetworkRepair[],
): Promise<void> {
	const network = getConfig().NITROBASE_NETWORK;
	const script = networkRepairScript(network, repairs);
	if (!script || !loop.executor) return;
	const result = await loop.executor.exec(script, {
		timeoutMs: getConfig().MONITORING_COMMAND_TIMEOUT_MS,
	});
	for (const repair of parseNetworkRepairs(result.stdout)) {
		const line = `[monitoring] ${repair.ok ? "repaired" : "could not repair"} ${repair.container} on ${network} (${repair.action})`;
		if (repair.ok) console.info(line);
		else console.warn(line);
		if (!repair.ok) continue;
		audit({
			teamId: loop.teamId,
			action: "server.network.repair",
			targetType: "server",
			targetId: loop.serverId,
			meta: {
				container: repair.container,
				repair: repair.action,
				trigger: "monitoring",
			},
			request: { ip: null, userAgent: null },
		});
	}
}

async function runTick(loop: Loop): Promise<void> {
	let samples: TickSamples = { server: null, containers: null };
	let error: ErrorInfo | undefined;
	try {
		samples = await collect(loop);
		loop.failures = 0;
	} catch (cause) {
		loop.failures += 1;
		error = errorInfoOf(cause);
		// Fresh connection next time (dead socket, changed credentials...).
		loop.executor?.close();
		loop.executor = null;
	}
	if (loop.stopped) {
		loop.executor?.close();
		loop.executor = null;
		return;
	}
	const now = Date.now();
	if (samples.server) {
		writers().server.add([{ serverId: loop.serverId, sample: samples.server }]);
	}
	if (samples.containers) {
		writers().container.add(
			samples.containers.map((sample) => ({
				serverId: loop.serverId,
				sample,
			})),
		);
	}
	setStatus(loop.serverId, error ? "backoff" : "collecting");
	publish(loop.serverId, {
		ts: now,
		ok: !error,
		error,
		server: samples.server,
		containers: samples.containers?.map(stripLabel) ?? null,
	});
	// Never while a job works on the server or the container's app (a
	// deploy between create and attach, a move, a restore...): the job
	// attaches what it creates. Streaks only move on ticks that saw the
	// containers.
	if (samples.containers && !isServerBusy(loop.serverId)) {
		const idle = (samples.networkRepairs ?? []).filter(
			(repair) => !repair.appId || !isAppBusy(loop.serverId, repair.appId),
		);
		const guard = guardNetworkRepairs(
			idle,
			loop.networkStreak ?? new Map(),
			getConfig().NETWORK_REPAIR_MAX_ATTEMPTS,
		);
		loop.networkStreak = guard.streak;
		loop.networkFlaps = guard.flapping;
		if (guard.run.length) {
			await repairNetworks(loop, guard.run).catch((cause) =>
				console.warn(
					`[monitoring] network repair failed on ${loop.serverId}:`,
					cause instanceof Error ? cause.message : cause,
				),
			);
		}
	}
	try {
		await evaluateAlerts(loop, samples, now);
	} catch (cause) {
		loop.openAlerts = null; // reload from the DB next tick
		console.error(
			`[monitoring] alert evaluation failed on ${loop.serverId}`,
			cause,
		);
	}
	if (error && loop.failures === 1) {
		console.warn(
			`[monitoring] collection failed on ${loop.serverId}: ${error.text}`,
		);
	}
}

function scheduleNext(loop: Loop): void {
	if (loop.stopped) return;
	const config = getConfig();
	const poked = loop.poke;
	loop.timer = setTimeout(
		() => {
			loop.timer = null;
			if (loop.poke) {
				// Fresh connection: the old one may be the dead one.
				loop.poke = false;
				loop.executor?.close();
				loop.executor = null;
			}
			void runTick(loop)
				.catch((error) => console.error("[monitoring] tick failed", error))
				.finally(() => scheduleNext(loop));
		},
		poked
			? 0
			: nextDelay(
					loop.failures,
					config.MONITORING_INTERVAL_MS,
					config.MONITORING_BACKOFF_MAX_MS,
				),
	);
	loop.timer.unref?.();
}

/**
 * Collect now with a fresh connection and no backoff (e.g. right after a
 * successful manual connection test, so an unreachable alert resolves at
 * once instead of after the backoff).
 */
function pokeLoop(serverId: string): boolean {
	const loop = state.loops.get(serverId);
	if (!loop || loop.stopped) return false;
	loop.poke = true;
	// Waiting for the next tick: run it now. A running tick reschedules
	// itself right away when it ends (scheduleNext sees `poke`).
	if (loop.timer) {
		clearTimeout(loop.timer);
		loop.timer = null;
		scheduleNext(loop);
	}
	return true;
}

function startLoop(server: ServerRow): void {
	const loop: Loop = {
		serverId: server.id,
		teamId: server.teamId,
		fingerprint: connectionFingerprint(server),
		server,
		executor: null,
		timer: null,
		stopped: false,
		failures: 0,
		collectorState: new Map(),
		restartHistory: null,
		openAlerts: null,
		poke: false,
	};
	state.loops.set(server.id, loop);
	setStatus(server.id, "collecting");
	// First tick soon (not all at once after boot).
	loop.timer = setTimeout(
		() => {
			loop.timer = null;
			void runTick(loop)
				.catch((error) => console.error("[monitoring] tick failed", error))
				.finally(() => scheduleNext(loop));
		},
		Math.floor(Math.random() * getConfig().MONITORING_START_JITTER_MS),
	);
	loop.timer.unref?.();
}

function stopLoop(serverId: string): void {
	const loop = state.loops.get(serverId);
	if (!loop) return;
	loop.stopped = true;
	if (loop.timer) clearTimeout(loop.timer);
	loop.executor?.close();
	loop.executor = null;
	state.loops.delete(serverId);
	setStatus(serverId, "inactive");
}

/** Start loops for Ready servers, stop the others, restart on credential changes. */
async function reconcileMonitoring(): Promise<void> {
	if (state.reconciling) return;
	state.reconciling = true;
	try {
		if (!getConfig().MONITORING_ENABLED) {
			for (const id of [...state.loops.keys()]) stopLoop(id);
			return;
		}
		const ready = await listReadyServers();
		const readyIds = new Set(ready.map((server) => server.id));
		for (const id of [...state.loops.keys()]) {
			if (!readyIds.has(id)) stopLoop(id);
		}
		for (const server of ready) {
			const loop = state.loops.get(server.id);
			if (loop && loop.fingerprint === connectionFingerprint(server)) {
				loop.server = server;
				continue;
			}
			if (loop) stopLoop(server.id);
			startLoop(server);
		}
		for (const id of [...state.hub.keys()]) {
			const entry = state.hub.get(id);
			// Forget servers that are gone and nobody watches.
			if (entry && !readyIds.has(id) && entry.subscribers.size === 0) {
				state.hub.delete(id);
			}
		}
	} finally {
		state.reconciling = false;
	}
}

/** Boot: reconcile loops on a schedule, plus rollup and retention jobs. */
export function registerMonitoring(): void {
	const config = getConfig();
	const globalFlag = globalThis as typeof globalThis & {
		__nitrobaseMonitoringPoke?: boolean;
	};
	if (!globalFlag.__nitrobaseMonitoringPoke) {
		globalFlag.__nitrobaseMonitoringPoke = true;
		onEvent((event) => {
			if (event.id === "job.connection_test.succeeded" && event.serverId) {
				pokeLoop(event.serverId);
			}
		});
	}
	schedule("monitoring:reconcile", config.MONITORING_RECONCILE_CRON, () =>
		reconcileMonitoring(),
	);
	void reconcileMonitoring().catch((error) =>
		console.error("[monitoring] reconcile failed", error),
	);
	const lookback = config.METRICS_ROLLUP_LOOKBACK_MINUTES * 60;
	schedule("metrics:rollup", config.METRICS_ROLLUP_CRON, () =>
		rollupMetrics(new Date(), lookback),
	);
	// At boot, roll up everything still raw (rows from before a restart).
	void rollupMetrics(
		new Date(),
		resolutionSettings(config).rawRetentionSeconds,
	).catch((error) => console.error("[monitoring] rollup failed", error));
	schedule("metrics:retention", config.METRICS_RETENTION_CRON, () =>
		pruneMetrics(new Date()),
	);
}

/** Shutdown: stop loops and write buffered samples. */
export async function stopMonitoring(): Promise<void> {
	unschedule("monitoring:reconcile");
	for (const id of [...state.loops.keys()]) stopLoop(id);
	await state.writers?.server.stop();
	await state.writers?.container.stop();
}

/**
 * Ticks for a new subscriber: the live ring, or (no loop yet / after a
 * restart) one synthetic tick from the newest stored samples.
 */
export async function initialTicks(serverId: string): Promise<LiveTick[]> {
	const live = liveSnapshot(serverId).ticks;
	if (live.length > 0) return live;
	const since = new Date(
		Date.now() - 2 * getConfig().MONITORING_BACKOFF_MAX_MS,
	);
	const [servers, containers] = await Promise.all([
		latestServerSamples([serverId], since),
		latestContainerSamples(serverId, since),
	]);
	const server = servers.get(serverId) ?? null;
	if (!server && containers.length === 0) return [];
	return [
		{
			ts: server?.ts ?? containers[0]?.ts ?? Date.now(),
			ok: true,
			server,
			containers: containers.map(stripLabel),
		},
	];
}

/** Latest health per server (dashboard, server list). */
export async function serverHealthSummaries(
	serverIds: string[],
): Promise<ServerHealthSummary[]> {
	const since = new Date(
		Date.now() - 2 * getConfig().MONITORING_BACKOFF_MAX_MS,
	);
	const missing = serverIds.filter(
		(id) => !state.hub.get(id)?.ring.some((tick) => tick.server),
	);
	const stored = await latestServerSamples(missing, since);
	return serverIds.map((serverId) => {
		const ring = state.hub.get(serverId)?.ring ?? [];
		const sample =
			[...ring].reverse().find((tick) => tick.server)?.server ??
			stored.get(serverId) ??
			null;
		const fullest = (sample?.disks ?? [])
			.map((disk) => ({ mount: disk.mount, percent: diskPercent(disk) }))
			.sort((a, b) => b.percent - a.percent)[0];
		return {
			serverId,
			status: monitorStatus(serverId),
			ts: sample?.ts ?? null,
			cpuPercent: sample?.cpuPercent ?? null,
			memPercent:
				sample?.memUsed != null && sample.memTotal
					? Math.round((sample.memUsed / sample.memTotal) * 1000) / 10
					: null,
			disk: fullest ?? null,
		};
	});
}
