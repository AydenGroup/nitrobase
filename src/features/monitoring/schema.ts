import { z } from "zod";
import { metricRangeIds } from "#/config/metrics.ts";
import type { DiskUsageRecord } from "#/db/schema/monitoring.ts";
import type { ErrorInfo } from "#/libs/coded.ts";

const MetricRangeSchema = z.enum(metricRangeIds);
export type MetricRange = z.infer<typeof MetricRangeSchema>;

export const ServerHistoryInputSchema = z.object({
	serverId: z.guid(),
	range: MetricRangeSchema,
});

export const AppHistoryInputSchema = z.object({
	appId: z.guid(),
	range: MetricRangeSchema,
});

export const AlertListInputSchema = z.object({
	serverId: z.guid().optional(),
	appId: z.guid().optional(),
	status: z.enum(["open", "resolved", "all"]).default("open"),
	limit: z.number().int().min(1).max(200).default(50),
});
export type AlertListInput = z.input<typeof AlertListInputSchema>;

/**
 * `problem` of app-stream ticks when collection failed (key of
 * `alertRuleMeta`): the raw error stays on the server stream.
 */
export const APP_STREAM_UNREACHABLE = "server_unreachable";

/** Live sample pushed over SSE (dates as epoch ms). */
export interface LiveServerSample {
	ts: number;
	cpuPercent: number | null;
	load1: number | null;
	load5: number | null;
	load15: number | null;
	memUsed: number | null;
	memTotal: number | null;
	swapUsed: number | null;
	swapTotal: number | null;
	netRxBps: number | null;
	netTxBps: number | null;
	uptimeSeconds: number | null;
	disks: DiskUsageRecord[];
}

export interface LiveContainerSample {
	ts: number;
	container: string;
	appId: string | null;
	service: string | null;
	state: string | null;
	health: string | null;
	restartCount: number | null;
	cpuPercent: number | null;
	memUsed: number | null;
	memLimit: number | null;
	netRxBps: number | null;
	netTxBps: number | null;
}

export interface LiveTick {
	ts: number;
	ok: boolean;
	/** Why collection failed (server stream; raw output as text). */
	error?: ErrorInfo;
	/** App stream: key of `alertRuleMeta` when collection failed. */
	problem?: string;
	server: LiveServerSample | null;
	containers: LiveContainerSample[] | null;
}

/** Collection loop state of a server, as shown in the UI. */
export type MonitorStatus = "collecting" | "backoff" | "inactive";

export interface HistoryPoint {
	t: number;
	cpuPercent: number | null;
	load1: number | null;
	load5: number | null;
	load15: number | null;
	memUsed: number | null;
	memTotal: number | null;
	swapUsed: number | null;
	swapTotal: number | null;
	netRxBps: number | null;
	netTxBps: number | null;
}

export interface DiskHistoryPoint {
	t: number;
	mount: string;
	used: number;
	total: number;
	percent: number;
}

export interface ServerHistory {
	binSeconds: number;
	points: HistoryPoint[];
	disks: DiskHistoryPoint[];
}

export interface ContainerHistoryPoint {
	t: number;
	container: string;
	service: string | null;
	cpuPercent: number | null;
	memUsed: number | null;
	memLimit: number | null;
	netRxBps: number | null;
	netTxBps: number | null;
	restartCount: number | null;
}

export interface AppHistory {
	binSeconds: number;
	points: ContainerHistoryPoint[];
}

export interface AlertDTO {
	id: string;
	serverId: string;
	serverName: string;
	appId: string | null;
	appName: string | null;
	rule: string;
	subject: string;
	severity: string;
	status: "open" | "resolved";
	value: number | null;
	threshold: number | null;
	openedAt: Date;
	lastSeenAt: Date;
	resolvedAt: Date | null;
}

/** Latest known state of a server for summaries (dashboard, lists). */
export interface ServerHealthSummary {
	serverId: string;
	status: MonitorStatus;
	ts: number | null;
	cpuPercent: number | null;
	memPercent: number | null;
	/** Fullest real filesystem. */
	disk: { mount: string; percent: number } | null;
}

export interface MonitoringSnapshot {
	status: MonitorStatus;
	/** Live ring buffer (oldest first). */
	ticks: LiveTick[];
	/** Config: alert thresholds the UI marks on charts. */
	thresholds: { diskPercent: number; memoryPercent: number };
	intervalMs: number;
}
