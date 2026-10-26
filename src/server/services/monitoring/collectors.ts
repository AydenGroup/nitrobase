import { planNetworkRepairs } from "#/server/services/apps/networks.ts";
import { internalError } from "#/utils/error.ts";
import {
	containerStatsScript,
	serverStatsScript,
	splitSections,
} from "./commands";
import {
	type CpuTimes,
	cpuPercent,
	type DfFilter,
	type NetCounters,
	parseCpuStat,
	parseDf,
	parseDockerInspect,
	parseDockerStats,
	parseLoadavg,
	parseMeminfo,
	parseNetDev,
	parseUptime,
	rate,
} from "./parsers";
import type { ContainerSample, TickSamples } from "./types";

export interface CollectorSettings extends DfFilter {
	ignoreNetPrefixes: string[];
	/**
	 * Shared proxy network and this panel's instance id: app containers of
	 * this panel found off the network (routed) or registered there under
	 * other names are repaired after the tick (see apps/networks.ts).
	 */
	proxyNetwork?: string;
	instanceId?: string | null;
}

export interface CollectorContext {
	/** Tick time (ms). */
	now: number;
	settings: CollectorSettings;
	/** Templates of the apps on this server (app-specific collectors). */
	templateIds: ReadonlySet<string>;
}

interface CollectResult<S> {
	samples: Partial<TickSamples>;
	/** Kept per server and handed back next tick (deltas, rates). */
	state: S;
}

/**
 * A metric collector. Adding one = one module implementing this plus a
 * registration (`metricCollectors` below, or `collectors` of a server
 * plugin in #/plugins/server.ts for app-specific ones). `command` must be
 * built from trusted constants only; it runs in a subshell of the tick's
 * single remote command.
 */
export interface MetricCollector<S = unknown> {
	/** Stable id (`[a-z][a-z0-9-]*`), also the output section name. */
	id: string;
	appliesTo?(ctx: CollectorContext): boolean;
	command(ctx: CollectorContext): string;
	collect(
		output: string,
		previous: S | undefined,
		ctx: CollectorContext,
	): CollectResult<S>;
}

interface ServerCollectorState {
	cpu: CpuTimes | null;
	net: NetCounters | null;
	ts: number;
}

/** CPU, load, memory, swap, disks, network and uptime from /proc + df. */
export const serverCollector: MetricCollector<ServerCollectorState> = {
	id: "server",
	command: () => serverStatsScript(),
	collect(output, previous, ctx) {
		const sections = splitSections(output);
		const cpu = parseCpuStat(sections.get("stat") ?? "");
		const net = parseNetDev(
			sections.get("netdev") ?? "",
			ctx.settings.ignoreNetPrefixes,
		);
		const seconds = previous ? (ctx.now - previous.ts) / 1000 : 0;
		const meminfo = sections.get("meminfo") ?? "";
		if (!cpu && !meminfo) {
			throw internalError("No /proc data in collector output");
		}
		return {
			state: { cpu, net, ts: ctx.now },
			samples: {
				server: {
					ts: ctx.now,
					cpuPercent: cpuPercent(previous?.cpu, cpu),
					...parseLoadavg(sections.get("loadavg") ?? ""),
					...parseMeminfo(meminfo),
					netRxBps: rate(previous?.net?.rx, net?.rx, seconds),
					netTxBps: rate(previous?.net?.tx, net?.tx, seconds),
					uptimeSeconds: parseUptime(sections.get("uptime") ?? ""),
					disks: parseDf(sections.get("df") ?? "", ctx.settings),
				},
			},
		};
	},
};

type ContainerCollectorState = {
	ts: number;
	net: Map<string, { rx: number | null; tx: number | null }>;
};

/** Container state, health, restarts (inspect) and usage (docker stats). */
export const containerCollector: MetricCollector<ContainerCollectorState> = {
	id: "containers",
	command: (ctx) => containerStatsScript(ctx.settings.proxyNetwork),
	collect(output, previous, ctx) {
		const sections = splitSections(output);
		const inspect = parseDockerInspect(sections.get("inspect") ?? "");
		const stats = new Map(
			parseDockerStats(sections.get("stats") ?? "").map((row) => [
				row.name,
				row,
			]),
		);
		const seconds = previous ? (ctx.now - previous.ts) / 1000 : 0;
		const net: ContainerCollectorState["net"] = new Map();
		const containers: ContainerSample[] = inspect.map((row) => {
			const usage = stats.get(row.name);
			const before = previous?.net.get(row.name);
			if (usage) net.set(row.name, { rx: usage.netRx, tx: usage.netTx });
			return {
				ts: ctx.now,
				container: row.name,
				appLabel: row.appLabel,
				project: row.project,
				appId: null,
				service: row.service,
				state: row.state,
				health: row.health,
				restartCount: row.restartCount,
				oomKilled: row.oomKilled,
				...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
				cpuPercent: usage?.cpuPercent ?? null,
				memUsed: usage?.memUsed ?? null,
				memLimit: usage?.memLimit ?? null,
				netRxBps: usage ? rate(before?.rx, usage.netRx, seconds) : null,
				netTxBps: usage ? rate(before?.tx, usage.netTx, seconds) : null,
			};
		});
		const networkRepairs = ctx.settings.proxyNetwork
			? planNetworkRepairs(
					inspect.flatMap((row) => (row.network ? [row.network] : [])),
					{
						instanceId: ctx.settings.instanceId ?? null,
						network: ctx.settings.proxyNetwork,
					},
				)
			: [];
		return {
			state: { ts: ctx.now, net },
			samples: {
				containers,
				...(networkRepairs.length ? { networkRepairs } : {}),
			},
		};
	},
};

/** Built-in collectors, run on every Ready server. */
export const metricCollectors: MetricCollector[] = [
	serverCollector as MetricCollector,
	containerCollector as MetricCollector,
];
