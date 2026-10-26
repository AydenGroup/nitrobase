import type { DiskUsageRecord } from "#/db/schema/monitoring.ts";
import {
	type ContainerNetworkState,
	parseNetworkState,
} from "#/server/services/apps/networks.ts";

/**
 * Pure parsers for the monitoring collectors (Linux /proc, GNU df, Docker
 * CLI). They never throw on odd input: unknown lines are skipped and
 * missing values become null.
 */

const num = (value: string | undefined): number | null => {
	if (value === undefined || value.trim() === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

export interface CpuTimes {
	/** All jiffies (guest time is already part of user/nice). */
	total: number;
	/** idle + iowait. */
	idle: number;
}

/** First `cpu ` line of /proc/stat. */
export function parseCpuStat(text: string): CpuTimes | null {
	const line = text.split("\n").find((item) => /^cpu\s/.test(item));
	if (!line) return null;
	const fields = line.trim().split(/\s+/).slice(1).map(Number);
	if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) {
		return null;
	}
	// user nice system idle iowait irq softirq steal [guest guest_nice]
	const total = fields.slice(0, 8).reduce((sum, value) => sum + value, 0);
	const idle = fields[3] + (fields[4] ?? 0);
	return { total, idle };
}

/** Busy share between two /proc/stat readings, 0–100 (null if unusable). */
export function cpuPercent(
	previous: CpuTimes | null | undefined,
	current: CpuTimes | null,
): number | null {
	if (!previous || !current) return null;
	const total = current.total - previous.total;
	const idle = current.idle - previous.idle;
	// Counter reset (reboot) or no time passed.
	if (total <= 0 || idle < 0) return null;
	return clampPercent(((total - idle) / total) * 100);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}

/** /proc/loadavg: "0.10 0.20 0.30 1/234 5678". */
export function parseLoadavg(text: string): {
	load1: number | null;
	load5: number | null;
	load15: number | null;
} {
	const [load1, load5, load15] = text.trim().split(/\s+/);
	return { load1: num(load1), load5: num(load5), load15: num(load15) };
}

/** /proc/meminfo → bytes. Used = total − available (as `free` reports). */
export function parseMeminfo(text: string): {
	memUsed: number | null;
	memTotal: number | null;
	swapUsed: number | null;
	swapTotal: number | null;
} {
	const values = new Map<string, number>();
	for (const line of text.split("\n")) {
		const match = line.match(/^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?\s*$/);
		if (match) values.set(match[1], Number(match[2]) * 1024);
	}
	const total = values.get("MemTotal") ?? null;
	const available =
		values.get("MemAvailable") ??
		(values.has("MemFree")
			? (values.get("MemFree") ?? 0) +
				(values.get("Buffers") ?? 0) +
				(values.get("Cached") ?? 0)
			: null);
	const swapTotal = values.get("SwapTotal") ?? null;
	const swapFree = values.get("SwapFree") ?? null;
	return {
		memTotal: total,
		memUsed:
			total !== null && available !== null
				? Math.max(0, total - available)
				: null,
		swapTotal,
		swapUsed:
			swapTotal !== null && swapFree !== null
				? Math.max(0, swapTotal - swapFree)
				: null,
	};
}

export interface NetCounters {
	rx: number;
	tx: number;
}

/**
 * /proc/net/dev: summed rx/tx bytes of host interfaces, skipping any whose
 * name starts with one of `ignorePrefixes` (loopback, bridges, veths...).
 */
export function parseNetDev(
	text: string,
	ignorePrefixes: string[],
): NetCounters | null {
	let rx = 0;
	let tx = 0;
	let seen = false;
	for (const line of text.split("\n")) {
		const match = line.match(/^\s*([^:\s]+):\s*(.*)$/);
		if (!match) continue;
		const name = match[1];
		if (ignorePrefixes.some((prefix) => name.startsWith(prefix))) continue;
		const fields = match[2].trim().split(/\s+/).map(Number);
		if (fields.length < 9 || !Number.isFinite(fields[0])) continue;
		rx += fields[0];
		tx += fields[8];
		seen = true;
	}
	return seen ? { rx, tx } : null;
}

/** Bytes per second between two counter readings (null on reset). */
export function rate(
	previous: number | null | undefined,
	current: number | null | undefined,
	seconds: number,
): number | null {
	if (previous == null || current == null || seconds <= 0) return null;
	const delta = current - previous;
	if (delta < 0) return null;
	return Math.round((delta / seconds) * 100) / 100;
}

/** /proc/uptime: "12345.67 54321.00" → whole seconds. */
export function parseUptime(text: string): number | null {
	const value = num(text.trim().split(/\s+/)[0]);
	return value === null ? null : Math.floor(value);
}

export interface DfFilter {
	pseudoFs: string[];
	ignoreMountPrefixes: string[];
	/** Exact mount paths to drop (file bind mounts such as /etc/hosts). */
	ignoreMounts: string[];
}

/**
 * Whether a mount point is reported (live tiles, alerts and history alike).
 * The one place that decides it, so stored history recorded before a
 * filter change is narrowed the same way as new samples.
 */
export function isReportedMount(
	mount: string,
	filter: Pick<DfFilter, "ignoreMountPrefixes" | "ignoreMounts">,
): boolean {
	if (!mount.startsWith("/")) return false;
	if (filter.ignoreMounts.includes(mount)) return false;
	return !filter.ignoreMountPrefixes.some(
		(prefix) => mount === prefix.replace(/\/$/, "") || mount.startsWith(prefix),
	);
}

/**
 * `df -kPT` (GNU): real filesystems only. Pseudo filesystems and internal
 * mount points are dropped, and one filesystem mounted several times (bind
 * mounts: same device, or identical size/used/available) is reported once,
 * at its shortest mount path.
 */
export function parseDf(text: string, filter: DfFilter): DiskUsageRecord[] {
	const kept: (DiskUsageRecord & { device: string })[] = [];
	for (const line of text.split("\n").slice(1)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 7) continue;
		const [device, fs, sizeK, usedK, availK] = parts;
		const mount = parts.slice(6).join(" ");
		if (filter.pseudoFs.includes(fs)) continue;
		if (!isReportedMount(mount, filter)) continue;
		const total = num(sizeK);
		const used = num(usedK);
		const avail = num(availK);
		if (!total || used === null || avail === null) continue;
		const record = {
			device,
			mount,
			fs,
			total: total * 1024,
			used: used * 1024,
			avail: avail * 1024,
		};
		const index = kept.findIndex(
			(item) =>
				item.device === device ||
				(item.total === record.total &&
					item.used === record.used &&
					item.avail === record.avail),
		);
		if (index === -1) kept.push(record);
		else if (mount.length < kept[index].mount.length) kept[index] = record;
	}
	return kept
		.map(({ device: _device, ...disk }) => disk)
		.sort((a, b) => a.mount.localeCompare(b.mount));
}

/** Used share of a filesystem as df computes it: used / (used + avail). */
export function diskPercent(disk: Pick<DiskUsageRecord, "used" | "avail">) {
	const base = disk.used + disk.avail;
	return base > 0 ? clampPercent((disk.used / base) * 100) : 0;
}

const UNITS: Record<string, number> = {
	b: 1,
	kb: 1e3,
	mb: 1e6,
	gb: 1e9,
	tb: 1e12,
	kib: 1024,
	mib: 1024 ** 2,
	gib: 1024 ** 3,
	tib: 1024 ** 4,
};

/** Docker CLI sizes: "1.5GiB", "648B", "12.3kB" → bytes. */
export function parseSize(value: string | undefined): number | null {
	const match = value?.trim().match(/^([\d.]+)\s*([a-zA-Z]+)$/);
	if (!match) return null;
	const factor = UNITS[match[2].toLowerCase()];
	const amount = Number(match[1]);
	if (factor === undefined || !Number.isFinite(amount)) return null;
	return Math.round(amount * factor);
}

/** "used / limit" pairs of `docker stats` (MemUsage, NetIO). */
function parsePair(value: string | undefined): [number | null, number | null] {
	const [left, right] = (value ?? "").split("/");
	return [parseSize(left), parseSize(right)];
}

export interface DockerStatsRow {
	name: string;
	cpuPercent: number | null;
	memUsed: number | null;
	memLimit: number | null;
	netRx: number | null;
	netTx: number | null;
}

/** `docker stats --no-stream --format '{{json .}}'`: one JSON object per line. */
export function parseDockerStats(text: string): DockerStatsRow[] {
	const rows: DockerStatsRow[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		const name =
			typeof raw.Name === "string" ? raw.Name.replace(/^\//, "") : "";
		if (!name) continue;
		const [memUsed, memLimit] = parsePair(String(raw.MemUsage ?? ""));
		const [netRx, netTx] = parsePair(String(raw.NetIO ?? ""));
		const cpu = num(String(raw.CPUPerc ?? "").replace("%", ""));
		rows.push({
			name,
			cpuPercent: cpu === null ? null : Math.round(cpu * 100) / 100,
			memUsed,
			memLimit,
			netRx,
			netTx,
		});
	}
	return rows;
}

export interface DockerInspectRow {
	name: string;
	appLabel: string | null;
	service: string | null;
	state: string | null;
	health: string | null;
	restartCount: number | null;
	/** The kernel OOM-killed it (Docker resets this on start). */
	oomKilled?: boolean;
	/** Exit code of its last run (0 while it never stopped). */
	exitCode?: number | null;
	/** `com.docker.compose.project` label (the app folder for Nitrobase apps). */
	project: string | null;
	/** Place on the proxy network (`inspectFormat(network)` only). */
	network?: ContainerNetworkState;
}

/** Fields of `INSPECT_FORMAT` before the optional network state. */
const INSPECT_FIELDS = 9;

/** Field order of `inspectFormat` in commands.ts (tab separated). */
export function parseDockerInspect(text: string): DockerInspectRow[] {
	const rows: DockerInspectRow[] = [];
	for (const line of text.split("\n")) {
		const parts = line.split("\t");
		if (parts.length < 6) continue;
		const extra = parts.slice(INSPECT_FIELDS);
		const [
			name,
			app,
			service,
			state,
			health,
			restarts,
			project = "",
			oom = "",
			exit = "",
		] = parts.map((part) => part.trim());
		const clean = (value: string) =>
			value && value !== "<no value>" ? value : null;
		const container = name.replace(/^\//, "");
		if (!container) continue;
		rows.push({
			name: container,
			appLabel: clean(app),
			service: clean(service),
			state: clean(state),
			health: clean(health),
			restartCount: num(restarts),
			project: clean(project),
			...(oom === "true" ? { oomKilled: true } : {}),
			...(exit ? { exitCode: num(exit) } : {}),
			// Trailing empty fields may be trimmed off the last line.
			...(extra.length > 0
				? { network: parseNetworkState(container, clean(app), extra) }
				: {}),
		});
	}
	return rows;
}
