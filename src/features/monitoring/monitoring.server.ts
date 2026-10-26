import { and, desc, eq, inArray, lt, type SQL, sql } from "drizzle-orm";
import { rangeSeconds } from "#/config/metrics.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import {
	alerts,
	metricsContainer,
	metricsServer,
} from "#/db/schema/monitoring.ts";
import { servers } from "#/db/schema/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import {
	historyPlan,
	type ResolutionSettings,
	retentionCutoffs,
	rollupWindow,
} from "#/server/services/monitoring/history.ts";
import { isReportedMount } from "#/server/services/monitoring/parsers.ts";
import type {
	ContainerSample,
	ServerSample,
} from "#/server/services/monitoring/types.ts";
import type {
	AlertDTO,
	AlertListInput,
	AppHistory,
	ContainerHistoryPoint,
	DiskHistoryPoint,
	HistoryPoint,
	MetricRange,
	ServerHistory,
} from "./schema";

/** Storage resolution settings from config. */
export function resolutionSettings(config = getConfig()): ResolutionSettings {
	return {
		intervalSeconds: Math.ceil(config.MONITORING_INTERVAL_MS / 1000),
		rawRetentionSeconds: config.METRICS_RAW_RETENTION_HOURS * 3600,
		rollupBucketSeconds: config.METRICS_ROLLUP_BUCKET_MINUTES * 60,
		rollupRetentionSeconds: config.METRICS_ROLLUP_RETENTION_DAYS * 86_400,
		points: config.METRICS_CHART_POINTS,
	};
}

// ---------------------------------------------------------------- writes

export interface ServerSampleRow {
	serverId: string;
	sample: ServerSample;
}

export interface ContainerSampleRow {
	serverId: string;
	sample: ContainerSample;
}

/** Postgres caps bind parameters at 65535 per statement. */
const INSERT_CHUNK = 1000;

function chunks<T>(rows: T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
		out.push(rows.slice(i, i + INSERT_CHUNK));
	}
	return out;
}

const isForeignKeyViolation = (error: unknown): boolean => {
	const code =
		(error as { code?: string; cause?: { code?: string } })?.code ??
		(error as { cause?: { code?: string } })?.cause?.code;
	return code === "23503";
};

/**
 * Rows buffered for a server/app deleted before the flush violate the FK
 * (and would fail the whole batch): drop those and retry once.
 */
async function withoutDeletedTargets<T extends { serverId: string }>(
	rows: T[],
	write: (rows: T[]) => Promise<void>,
	appIdOf: (row: T) => string | null = () => null,
): Promise<void> {
	try {
		await write(rows);
	} catch (error) {
		if (!isForeignKeyViolation(error)) throw error;
		const serverIds = [...new Set(rows.map((row) => row.serverId))];
		const appIds = [
			...new Set(
				rows.flatMap((row) => {
					const appId = appIdOf(row);
					return appId ? [appId] : [];
				}),
			),
		];
		const [liveServers, liveApps] = await Promise.all([
			db
				.select({ id: servers.id })
				.from(servers)
				.where(inArray(servers.id, serverIds)),
			appIds.length > 0
				? db.select({ id: apps.id }).from(apps).where(inArray(apps.id, appIds))
				: Promise.resolve([]),
		]);
		const serverSet = new Set(liveServers.map((row) => row.id));
		const appSet = new Set(liveApps.map((row) => row.id));
		await write(
			rows.filter(
				(row) =>
					serverSet.has(row.serverId) &&
					(!appIdOf(row) || appSet.has(appIdOf(row) ?? "")),
			),
		);
	}
}

export function insertServerSamples(rows: ServerSampleRow[]): Promise<void> {
	return withoutDeletedTargets(rows, writeServerSamples);
}

export function insertContainerSamples(
	rows: ContainerSampleRow[],
): Promise<void> {
	return withoutDeletedTargets(
		rows,
		writeContainerSamples,
		(row) => row.sample.appId,
	);
}

async function writeServerSamples(rows: ServerSampleRow[]): Promise<void> {
	for (const chunk of chunks(rows)) {
		await db
			.insert(metricsServer)
			.values(
				chunk.map(({ serverId, sample }) => ({
					serverId,
					ts: new Date(sample.ts),
					bucketSeconds: 0,
					cpuPercent: sample.cpuPercent,
					load1: sample.load1,
					load5: sample.load5,
					load15: sample.load15,
					memUsed: sample.memUsed,
					memTotal: sample.memTotal,
					swapUsed: sample.swapUsed,
					swapTotal: sample.swapTotal,
					netRxBps: sample.netRxBps,
					netTxBps: sample.netTxBps,
					uptimeSeconds: sample.uptimeSeconds,
					disks: sample.disks,
				})),
			)
			// A duplicate (server, ts) is ignored.
			.onConflictDoNothing();
	}
}

async function writeContainerSamples(
	rows: ContainerSampleRow[],
): Promise<void> {
	for (const chunk of chunks(rows)) {
		await db
			.insert(metricsContainer)
			.values(
				chunk.map(({ serverId, sample }) => ({
					serverId,
					appId: sample.appId,
					container: sample.container,
					service: sample.service,
					ts: new Date(sample.ts),
					bucketSeconds: 0,
					state: sample.state,
					health: sample.health,
					restartCount: sample.restartCount,
					cpuPercent: sample.cpuPercent,
					memUsed: sample.memUsed,
					memLimit: sample.memLimit,
					netRxBps: sample.netRxBps,
					netTxBps: sample.netTxBps,
				})),
			)
			.onConflictDoNothing();
	}
}

// ------------------------------------------------- rollups and retention

const EPOCH = sql.raw("TIMESTAMPTZ 'epoch'");

/**
 * Aggregate raw rows of complete buckets in the lookback window into
 * rollup rows (averages; disks/state = last value; counters = max).
 * Upserts, so re-running a window is harmless.
 */
export async function rollupMetrics(
	now: Date,
	lookbackSeconds: number,
	config = getConfig(),
): Promise<void> {
	const bucket = config.METRICS_ROLLUP_BUCKET_MINUTES * 60;
	const window = rollupWindow(now, bucket, lookbackSeconds);
	if (!window) return;
	const bin = sql`date_bin(make_interval(secs => ${bucket}), ts, ${EPOCH})`;
	await db.execute(sql`
		INSERT INTO metrics_server (server_id, ts, bucket_seconds, cpu_percent,
			load1, load5, load15, mem_used, mem_total, swap_used, swap_total,
			net_rx_bps, net_tx_bps, uptime_seconds, disks)
		SELECT server_id, ${bin}, ${bucket}, avg(cpu_percent), avg(load1),
			avg(load5), avg(load15), avg(mem_used)::bigint, max(mem_total),
			avg(swap_used)::bigint, max(swap_total), avg(net_rx_bps),
			avg(net_tx_bps), max(uptime_seconds),
			(array_agg(disks ORDER BY ts DESC))[1]
		FROM metrics_server
		WHERE bucket_seconds = 0 AND ts >= ${window.from} AND ts < ${window.to}
		GROUP BY 1, 2
		ON CONFLICT (server_id, bucket_seconds, ts) DO UPDATE SET
			cpu_percent = excluded.cpu_percent, load1 = excluded.load1,
			load5 = excluded.load5, load15 = excluded.load15,
			mem_used = excluded.mem_used, mem_total = excluded.mem_total,
			swap_used = excluded.swap_used, swap_total = excluded.swap_total,
			net_rx_bps = excluded.net_rx_bps, net_tx_bps = excluded.net_tx_bps,
			uptime_seconds = excluded.uptime_seconds, disks = excluded.disks`);
	await db.execute(sql`
		INSERT INTO metrics_container (server_id, container, ts, bucket_seconds,
			app_id, service, state, health, restart_count, cpu_percent, mem_used,
			mem_limit, net_rx_bps, net_tx_bps)
		SELECT server_id, container, ${bin}, ${bucket},
			(array_agg(app_id ORDER BY ts DESC))[1],
			(array_agg(service ORDER BY ts DESC))[1],
			(array_agg(state ORDER BY ts DESC))[1],
			(array_agg(health ORDER BY ts DESC))[1],
			max(restart_count), avg(cpu_percent), avg(mem_used)::bigint,
			max(mem_limit), avg(net_rx_bps), avg(net_tx_bps)
		FROM metrics_container
		WHERE bucket_seconds = 0 AND ts >= ${window.from} AND ts < ${window.to}
		GROUP BY server_id, container, 3
		ON CONFLICT (server_id, container, bucket_seconds, ts) DO UPDATE SET
			app_id = excluded.app_id, service = excluded.service,
			state = excluded.state, health = excluded.health,
			restart_count = excluded.restart_count,
			cpu_percent = excluded.cpu_percent, mem_used = excluded.mem_used,
			mem_limit = excluded.mem_limit, net_rx_bps = excluded.net_rx_bps,
			net_tx_bps = excluded.net_tx_bps`);
}

/** Delete raw rows past raw retention and rollups past rollup retention. */
export async function pruneMetrics(now: Date): Promise<void> {
	const cutoffs = retentionCutoffs(now, resolutionSettings());
	for (const table of [metricsServer, metricsContainer]) {
		await db
			.delete(table)
			.where(and(eq(table.bucketSeconds, 0), lt(table.ts, cutoffs.raw)) as SQL);
		await db
			.delete(table)
			.where(
				and(
					sql`${table.bucketSeconds} > 0`,
					lt(table.ts, cutoffs.rollup),
				) as SQL,
			);
	}
	// Resolved alerts follow the rollup retention too.
	await db
		.delete(alerts)
		.where(
			and(
				eq(alerts.status, "resolved"),
				lt(alerts.resolvedAt, cutoffs.rollup),
			) as SQL,
		);
}

// ---------------------------------------------------------------- reads

const n = (value: unknown): number | null =>
	value === null || value === undefined ? null : Number(value);

const epochMs = (value: unknown): number =>
	value instanceof Date ? value.getTime() : new Date(String(value)).getTime();

export async function serverHistory(
	serverId: string,
	range: MetricRange,
): Promise<ServerHistory> {
	const plan = historyPlan(
		rangeSeconds(range),
		new Date(),
		resolutionSettings(),
	);
	const bin = sql`date_bin(make_interval(secs => ${plan.binSeconds}), ts, ${EPOCH})`;
	const where = sql`server_id = ${serverId} AND bucket_seconds = ${plan.bucketSeconds} AND ts >= ${plan.from}`;
	const config = getConfig();
	const mountFilter = {
		ignoreMountPrefixes: config.MONITORING_IGNORE_MOUNT_PREFIXES,
		ignoreMounts: config.MONITORING_IGNORE_MOUNTS,
	};
	const [main, disks] = await Promise.all([
		db.execute(sql`
			SELECT ${bin} AS t, avg(cpu_percent)::float8 AS cpu,
				avg(load1)::float8 AS load1, avg(load5)::float8 AS load5,
				avg(load15)::float8 AS load15, avg(mem_used)::float8 AS mem_used,
				max(mem_total)::float8 AS mem_total,
				avg(swap_used)::float8 AS swap_used,
				max(swap_total)::float8 AS swap_total,
				avg(net_rx_bps)::float8 AS rx, avg(net_tx_bps)::float8 AS tx
			FROM metrics_server WHERE ${where}
			GROUP BY 1 ORDER BY 1`),
		db.execute(sql`
			SELECT ${bin} AS t, d.mount AS mount, avg(d.used)::float8 AS used,
				max(d.total)::float8 AS total, avg(d.avail)::float8 AS avail
			FROM metrics_server,
				jsonb_to_recordset(disks) AS d(mount text, used float8, total float8, avail float8)
			WHERE ${where}
			GROUP BY 1, 2 ORDER BY 1, 2`),
	]);
	return {
		binSeconds: plan.binSeconds,
		points: main.rows.map(
			(row): HistoryPoint => ({
				t: epochMs(row.t),
				cpuPercent: n(row.cpu),
				load1: n(row.load1),
				load5: n(row.load5),
				load15: n(row.load15),
				memUsed: n(row.mem_used),
				memTotal: n(row.mem_total),
				swapUsed: n(row.swap_used),
				swapTotal: n(row.swap_total),
				netRxBps: n(row.rx),
				netTxBps: n(row.tx),
			}),
		),
		disks: disks.rows
			.filter((row) => isReportedMount(String(row.mount), mountFilter))
			.map((row): DiskHistoryPoint => {
				const used = Number(row.used);
				const avail = Number(row.avail);
				return {
					t: epochMs(row.t),
					mount: String(row.mount),
					used,
					total: Number(row.total),
					percent:
						used + avail > 0
							? Math.round((used / (used + avail)) * 10_000) / 100
							: 0,
				};
			}),
	};
}

export async function appHistory(
	appId: string,
	range: MetricRange,
): Promise<AppHistory> {
	const plan = historyPlan(
		rangeSeconds(range),
		new Date(),
		resolutionSettings(),
	);
	const bin = sql`date_bin(make_interval(secs => ${plan.binSeconds}), ts, ${EPOCH})`;
	const result = await db.execute(sql`
		SELECT ${bin} AS t, container, max(service) AS service,
			avg(cpu_percent)::float8 AS cpu, avg(mem_used)::float8 AS mem_used,
			max(mem_limit)::float8 AS mem_limit, avg(net_rx_bps)::float8 AS rx,
			avg(net_tx_bps)::float8 AS tx, max(restart_count) AS restarts
		FROM metrics_container
		WHERE app_id = ${appId} AND bucket_seconds = ${plan.bucketSeconds}
			AND ts >= ${plan.from}
		GROUP BY 1, 2 ORDER BY 1, 2`);
	return {
		binSeconds: plan.binSeconds,
		points: result.rows.map(
			(row): ContainerHistoryPoint => ({
				t: epochMs(row.t),
				container: String(row.container),
				service: row.service === null ? null : String(row.service),
				cpuPercent: n(row.cpu),
				memUsed: n(row.mem_used),
				memLimit: n(row.mem_limit),
				netRxBps: n(row.rx),
				netTxBps: n(row.tx),
				restartCount: n(row.restarts),
			}),
		),
	};
}

/** Newest stored server sample per server (summaries without a live loop). */
export async function latestServerSamples(
	serverIds: string[],
	since: Date,
): Promise<Map<string, ServerSample>> {
	if (serverIds.length === 0) return new Map();
	const rows = await db
		.selectDistinctOn([metricsServer.serverId])
		.from(metricsServer)
		.where(
			and(
				inArray(metricsServer.serverId, serverIds),
				eq(metricsServer.bucketSeconds, 0),
				sql`${metricsServer.ts} >= ${since}`,
			),
		)
		.orderBy(metricsServer.serverId, desc(metricsServer.ts));
	return new Map(
		rows.map((row) => [
			row.serverId,
			{
				ts: row.ts.getTime(),
				cpuPercent: row.cpuPercent,
				load1: row.load1,
				load5: row.load5,
				load15: row.load15,
				memUsed: row.memUsed,
				memTotal: row.memTotal,
				swapUsed: row.swapUsed,
				swapTotal: row.swapTotal,
				netRxBps: row.netRxBps,
				netTxBps: row.netTxBps,
				uptimeSeconds: row.uptimeSeconds,
				disks: row.disks,
			},
		]),
	);
}

/** Newest stored container samples of a server (no live loop). */
export async function latestContainerSamples(
	serverId: string,
	since: Date,
): Promise<ContainerSample[]> {
	const rows = await db
		.selectDistinctOn([metricsContainer.container])
		.from(metricsContainer)
		.where(
			and(
				eq(metricsContainer.serverId, serverId),
				eq(metricsContainer.bucketSeconds, 0),
				sql`${metricsContainer.ts} >= ${since}`,
			),
		)
		.orderBy(metricsContainer.container, desc(metricsContainer.ts));
	return rows.map((row) => ({
		ts: row.ts.getTime(),
		container: row.container,
		appLabel: row.appId,
		project: null,
		appId: row.appId,
		service: row.service,
		state: row.state,
		health: row.health,
		restartCount: row.restartCount,
		cpuPercent: row.cpuPercent,
		memUsed: row.memUsed,
		memLimit: row.memLimit,
		netRxBps: row.netRxBps,
		netTxBps: row.netTxBps,
	}));
}

/** Raw restart counts of a server's containers since `since` (oldest first). */
export async function recentRestartCounts(
	serverId: string,
	since: Date,
): Promise<{ container: string; ts: number; restartCount: number | null }[]> {
	const rows = await db
		.select({
			container: metricsContainer.container,
			ts: metricsContainer.ts,
			restartCount: metricsContainer.restartCount,
		})
		.from(metricsContainer)
		.where(
			and(
				eq(metricsContainer.serverId, serverId),
				eq(metricsContainer.bucketSeconds, 0),
				sql`${metricsContainer.ts} >= ${since}`,
			),
		)
		.orderBy(metricsContainer.ts);
	return rows.map((row) => ({ ...row, ts: row.ts.getTime() }));
}

// --------------------------------------------------------------- alerts

export async function listAlerts(
	actor: Actor,
	input: AlertListInput,
): Promise<AlertDTO[]> {
	const conditions: SQL[] = [eq(alerts.teamId, actor.teamId)];
	if (input.serverId) conditions.push(eq(alerts.serverId, input.serverId));
	if (input.appId) conditions.push(eq(alerts.appId, input.appId));
	const status = input.status ?? "open";
	if (status !== "all") conditions.push(eq(alerts.status, status));
	return db
		.select({
			id: alerts.id,
			serverId: alerts.serverId,
			serverName: servers.name,
			appId: alerts.appId,
			appName: apps.name,
			rule: alerts.rule,
			subject: alerts.subject,
			severity: alerts.severity,
			status: alerts.status,
			value: alerts.value,
			threshold: alerts.threshold,
			openedAt: alerts.openedAt,
			lastSeenAt: alerts.lastSeenAt,
			resolvedAt: alerts.resolvedAt,
		})
		.from(alerts)
		.innerJoin(servers, eq(servers.id, alerts.serverId))
		.leftJoin(apps, eq(apps.id, alerts.appId))
		.where(and(...conditions))
		.orderBy(desc(alerts.openedAt))
		.limit(input.limit ?? 50);
}
