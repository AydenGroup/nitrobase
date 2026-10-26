import { describe, expect, it } from "vitest";
import { createBatchWriter } from "./batch";
import {
	type CollectorContext,
	containerCollector,
	serverCollector,
} from "./collectors";
import { mapContainerApps, nextDelay } from "./loop";

const ctx = (now: number): CollectorContext => ({
	now,
	settings: {
		pseudoFs: ["tmpfs"],
		ignoreMountPrefixes: ["/var/lib/docker/"],
		ignoreMounts: ["/etc/hosts"],
		ignoreNetPrefixes: ["lo", "veth"],
	},
	templateIds: new Set(),
});

const serverOutput = (cpu: string, rx: number, tx: number) =>
	[
		"@@nitrobase-section stat",
		cpu,
		"@@nitrobase-section loadavg",
		"0.5 0.4 0.3 1/100 42",
		"@@nitrobase-section meminfo",
		"MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB",
		"@@nitrobase-section netdev",
		`  eth0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`,
		"@@nitrobase-section uptime",
		"100.5 1.0",
		"@@nitrobase-section df",
		"Filesystem Type 1024-blocks Used Available Capacity Mounted on",
		"/dev/sda1 ext4 100 60 40 60% /",
	].join("\n");

describe("server collector", () => {
	it("needs two ticks for CPU and rates", () => {
		const first = serverCollector.collect(
			serverOutput("cpu 100 0 0 900 0 0 0 0", 1000, 500),
			undefined,
			ctx(0),
		);
		expect(first.samples.server).toMatchObject({
			cpuPercent: null,
			netRxBps: null,
			memUsed: 750 * 1024,
			memTotal: 1000 * 1024,
			load1: 0.5,
			uptimeSeconds: 100,
			disks: [{ mount: "/", used: 60 * 1024 }],
		});
		const second = serverCollector.collect(
			serverOutput("cpu 150 0 0 950 0 0 0 0", 4000, 2000),
			first.state,
			ctx(15_000),
		);
		expect(second.samples.server).toMatchObject({
			cpuPercent: 50,
			netRxBps: 200,
			netTxBps: 100,
		});
	});

	it("rejects output without /proc data", () => {
		expect(() => serverCollector.collect("", undefined, ctx(0))).toThrow();
	});
});

describe("container collector", () => {
	const output = (rx: string) =>
		[
			"@@nitrobase-section inspect",
			"/pb-web\tapp-1\tweb\trunning\thealthy\t1",
			"/stopped\tapp-1\tworker\texited\t\t0",
			"@@nitrobase-section stats",
			`{"CPUPerc":"2.50%","MemUsage":"10MiB / 1GiB","Name":"pb-web","NetIO":"${rx} / 0B"}`,
		].join("\n");

	it("joins inspect and stats, rates from NetIO deltas", () => {
		const first = containerCollector.collect(output("1kB"), undefined, ctx(0));
		const second = containerCollector.collect(
			output("4kB"),
			first.state,
			ctx(10_000),
		);
		expect(second.samples.containers).toEqual([
			{
				ts: 10_000,
				container: "pb-web",
				appLabel: "app-1",
				project: null,
				appId: null,
				service: "web",
				state: "running",
				health: "healthy",
				restartCount: 1,
				cpuPercent: 2.5,
				memUsed: 10 * 1024 ** 2,
				memLimit: 1024 ** 3,
				netRxBps: 300,
				netTxBps: 0,
			},
			{
				ts: 10_000,
				container: "stopped",
				appLabel: "app-1",
				project: null,
				appId: null,
				service: "worker",
				state: "exited",
				health: null,
				restartCount: 0,
				cpuPercent: null,
				memUsed: null,
				memLimit: null,
				netRxBps: null,
				netTxBps: null,
			},
		]);
	});

	it("inspects the proxy network and plans repairs (BUG-006 self-heal)", () => {
		const settings = {
			...ctx(0).settings,
			proxyNetwork: "nitrobase-network",
			instanceId: "inst-1",
		};
		expect(containerCollector.command({ ...ctx(0), settings })).toContain(
			'{{with index .NetworkSettings.Networks "nitrobase-network"}}{{join .Aliases ","}}{{end}}',
		);
		const id = "ab".repeat(32);
		const net = (
			name: string,
			routed: string,
			networks: string,
			aliases: string,
		) =>
			`/${name}\tapp-1\t${name.split("-").pop()}\trunning\t\t0\tpb-1\tfalse\t0\t${id}\tinst-1\t${routed}\t${networks}\t${aliases}`;
		const inspect = [
			"@@nitrobase-section inspect",
			// Recreated by an old compose file: registered as `web`.
			net(
				"pb-1-web",
				"true",
				"pb-1_default,nitrobase-network,",
				"pb-1-web-1,web",
			),
			// Routed, off the network (manual `docker compose up`).
			net("pb-1-api", "true", "pb-1_default,", ""),
			// Fine.
			net("pb-1-ok", "true", "pb-1_default,nitrobase-network,", ""),
			net("pb-1-db", "<no value>", "pb-1_default,", ""),
		].join("\n");
		const collected = containerCollector.collect(inspect, undefined, {
			...ctx(0),
			settings,
		});
		expect(collected.samples.networkRepairs).toEqual([
			{ action: "realias", container: "pb-1-web", appId: "app-1" },
			{ action: "attach", container: "pb-1-api", appId: "app-1" },
		]);
		expect(collected.samples.containers).toHaveLength(4);
		// Without the network settings: no repair is planned.
		expect(
			containerCollector.collect(inspect, undefined, ctx(0)).samples
				.networkRepairs,
		).toBeUndefined();
	});

	it("keeps services without a healthcheck (BUG-016)", () => {
		const settings = {
			...ctx(0).settings,
			proxyNetwork: "nitrobase-network",
			instanceId: "inst-1",
		};
		const id = "cd".repeat(32);
		const line = (service: string, state: string, health: string) =>
			`/aw-1-${service}\tapp-1\t${service}\t${state}\t${health}\t35\taw-1\tfalse\t0\t${id}\tinst-1\t<no value>\taw-1_appwrite,\t`;
		const collected = containerCollector.collect(
			[
				"@@nitrobase-section inspect",
				line("appwrite", "running", "healthy"),
				line("appwrite-worker", "restarting", ""),
				line("appwrite-browser", "exited", ""),
				// The last line loses its empty trailing fields to trims.
				line("appwrite-realtime", "running", "").trimEnd(),
			].join("\n"),
			undefined,
			{ ...ctx(0), settings },
		);
		expect(
			collected.samples.containers?.map((row) => [
				row.service,
				row.state,
				row.health,
				row.restartCount,
			]),
		).toEqual([
			["appwrite", "running", "healthy", 35],
			["appwrite-worker", "restarting", null, 35],
			["appwrite-browser", "exited", null, 35],
			["appwrite-realtime", "running", null, 35],
		]);
		expect(collected.samples.networkRepairs).toBeUndefined();
	});

	it("is empty without docker", () => {
		expect(
			containerCollector.collect("", undefined, ctx(0)).samples.containers,
		).toEqual([]);
	});
});

describe("loop helpers", () => {
	it("maps app labels only to apps of the server", () => {
		const [own, foreign, stray] = mapContainerApps(
			[
				{ container: "a", appLabel: "app-1", project: "pb-app1" },
				{ container: "b", appLabel: "app-of-another-server", project: "x" },
				{ container: "c", appLabel: "app-1", project: "my-own-compose" },
			] as never,
			new Map([["app-1", "pb-app1"]]),
		);
		expect(own.appId).toBe("app-1");
		expect(foreign.appId).toBeNull();
		expect(stray.appId).toBeNull();
	});

	it("backs off exponentially up to the cap", () => {
		expect(nextDelay(0, 15_000, 300_000)).toBe(15_000);
		expect(nextDelay(1, 15_000, 300_000)).toBe(30_000);
		expect(nextDelay(3, 15_000, 300_000)).toBe(120_000);
		expect(nextDelay(10, 15_000, 300_000)).toBe(300_000);
	});

	it("batch writer flushes at the size limit and on stop", async () => {
		const writes: number[][] = [];
		const writer = createBatchWriter<number>({
			write: async (rows) => {
				writes.push(rows);
			},
			maxRows: 3,
			intervalMs: 60_000,
		});
		writer.add([1, 2]);
		expect(writes).toEqual([]);
		writer.add([3]);
		await writer.flush();
		writer.add([4]);
		await writer.stop();
		expect(writes).toEqual([[1, 2, 3], [4]]);
	});
});
