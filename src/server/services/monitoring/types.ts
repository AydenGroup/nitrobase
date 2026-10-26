import type { DiskUsageRecord } from "#/db/schema/monitoring.ts";
import type { NetworkRepair } from "#/server/services/apps/networks.ts";

/** One server sample (rates are per second over the last tick). */
export interface ServerSample {
	ts: number;
	/** Null on the first tick (needs two /proc/stat readings). */
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

/** One container sample. */
export interface ContainerSample {
	ts: number;
	/** Container name without the leading slash. */
	container: string;
	/** Raw `nitrobase.app` label (mapped to an app of the server later). */
	appLabel: string | null;
	/** Compose project label (must match the app's folder to count as the app's). */
	project: string | null;
	appId: string | null;
	service: string | null;
	state: string | null;
	/** healthy / unhealthy / starting, null without a healthcheck. */
	health: string | null;
	restartCount: number | null;
	/** OOM-killed (from `docker inspect`; not stored in metrics). */
	oomKilled?: boolean;
	/** Exit code of the last run (from `docker inspect`; not stored). */
	exitCode?: number | null;
	cpuPercent: number | null;
	memUsed: number | null;
	memLimit: number | null;
	netRxBps: number | null;
	netTxBps: number | null;
}

/** What one tick produced (a collector fills the parts it knows). */
export interface TickSamples {
	server: ServerSample | null;
	containers: ContainerSample[] | null;
	/** Proxy network repairs the tick found (not stored, run after it). */
	networkRepairs?: NetworkRepair[];
}
