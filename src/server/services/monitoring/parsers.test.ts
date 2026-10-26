import { describe, expect, it } from "vitest";
import {
	cpuPercent,
	diskPercent,
	isReportedMount,
	parseCpuStat,
	parseDf,
	parseDockerInspect,
	parseDockerStats,
	parseLoadavg,
	parseMeminfo,
	parseNetDev,
	parseSize,
	parseUptime,
	rate,
} from "./parsers";

describe("/proc/stat", () => {
	it("sums the first 8 fields and treats iowait as idle", () => {
		expect(
			parseCpuStat("cpu  100 0 50 800 50 0 0 0 10 0\ncpu0 1 2 3 4"),
		).toEqual({ total: 1000, idle: 850 });
	});

	it("computes busy % from two readings", () => {
		const a = parseCpuStat("cpu  100 0 50 800 50 0 0 0 0 0");
		const b = parseCpuStat("cpu  200 0 100 1100 100 0 0 0 0 0");
		// Total +500, idle +350 → 30% busy.
		expect(cpuPercent(a, b)).toBe(30);
	});

	it("returns null without a previous reading or on counter reset", () => {
		const a = parseCpuStat("cpu  100 0 50 800 50 0 0 0 0 0");
		const reset = parseCpuStat("cpu  10 0 5 80 5 0 0 0 0 0");
		expect(cpuPercent(null, a)).toBeNull();
		expect(cpuPercent(a, reset)).toBeNull();
		expect(cpuPercent(a, a)).toBeNull();
	});

	it("ignores garbage", () => {
		expect(parseCpuStat("")).toBeNull();
		expect(parseCpuStat("cpu a b c d")).toBeNull();
	});
});

describe("/proc/meminfo", () => {
	const meminfo = [
		"MemTotal:       16000000 kB",
		"MemFree:         1000000 kB",
		"MemAvailable:   12000000 kB",
		"Buffers:          100000 kB",
		"Cached:          2000000 kB",
		"SwapTotal:       2000000 kB",
		"SwapFree:        1500000 kB",
		"HugePages_Total:       0",
	].join("\n");

	it("uses MemAvailable for used memory", () => {
		expect(parseMeminfo(meminfo)).toEqual({
			memTotal: 16000000 * 1024,
			memUsed: 4000000 * 1024,
			swapTotal: 2000000 * 1024,
			swapUsed: 500000 * 1024,
		});
	});

	it("falls back to free + buffers + cached on old kernels", () => {
		const old = meminfo.replace(/MemAvailable.*\n/, "");
		expect(parseMeminfo(old).memUsed).toBe(
			(16000000 - 1000000 - 100000 - 2000000) * 1024,
		);
	});

	it("returns nulls when fields are missing", () => {
		expect(parseMeminfo("")).toEqual({
			memTotal: null,
			memUsed: null,
			swapTotal: null,
			swapUsed: null,
		});
	});
});

describe("/proc/net/dev", () => {
	const netdev = [
		"Inter-|   Receive                                                |  Transmit",
		" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
		"    lo:    5871      30    0    0    0     0          0         0     5871      30    0    0    0     0       0          0",
		"  eth0: 2000  126221    0    0    0     0          0         0  9000  107029    0    0    0     0       0          0",
		"  ens5:1000  1    0    0    0     0          0         0  500  1    0    0    0     0       0          0",
		"docker0: 2841948    2653    0    0    0     0          0         0 39737879    2908    0    2    0     0       0          0",
		"br-711fa726b722:  137772     672    0    0    0     0          0         0   267036     650    0    2    0     0       0          0",
		"vethdbd64e6:  160065     716    0    0    0     0          0         0   290472     853    0    0    0     0       0          0",
	].join("\n");
	const ignore = ["lo", "veth", "docker", "br-"];

	it("sums host interfaces only (also `name:value` without a space)", () => {
		expect(parseNetDev(netdev, ignore)).toEqual({ rx: 3000, tx: 9500 });
	});

	it("is null when every interface is ignored", () => {
		expect(parseNetDev(netdev, [...ignore, "eth", "ens"])).toBeNull();
	});

	it("rates are per second and null on reset", () => {
		expect(rate(1000, 4000, 15)).toBe(200);
		expect(rate(4000, 1000, 15)).toBeNull();
		expect(rate(null, 1000, 15)).toBeNull();
		expect(rate(1000, 2000, 0)).toBeNull();
	});
});

describe("loadavg / uptime", () => {
	it("parses", () => {
		expect(parseLoadavg("1.05 1.01 0.91 15/1202 74705\n")).toEqual({
			load1: 1.05,
			load5: 1.01,
			load15: 0.91,
		});
		expect(parseUptime("27517.73 270460.00")).toBe(27517);
		expect(parseUptime("")).toBeNull();
	});
});

describe("df -kPT", () => {
	const filter = {
		pseudoFs: ["tmpfs", "devtmpfs", "squashfs"],
		ignoreMountPrefixes: ["/var/lib/docker/", "/run/", "/snap/", "/dev/"],
		ignoreMounts: ["/etc/hosts", "/etc/resolv.conf"],
	};

	it("keeps real filesystems once, drops pseudo and docker mounts", () => {
		const df = [
			"Filesystem     Type    1024-blocks      Used Available Capacity Mounted on",
			"/dev/sda1      ext4       1000000    600000    400000      60% /",
			"tmpfs          tmpfs        65536         0     65536       0% /dev/shm",
			"tmpfs          tmpfs        65536         0     65536       0% /run",
			"/dev/sdb1      xfs        2000000   1800000    200000      90% /mnt/data dir",
			"/dev/sdb1      xfs        2000000   1800000    200000      90% /mnt/data dir/bind",
			"overlay        overlay    1000000    600000    400000      60% /var/lib/docker/overlay2/abc/merged",
			"/dev/loop0     squashfs     50000     50000         0     100% /snap/core/1",
		].join("\n");
		expect(parseDf(df, filter)).toEqual([
			{
				mount: "/",
				fs: "ext4",
				total: 1000000 * 1024,
				used: 600000 * 1024,
				avail: 400000 * 1024,
			},
			{
				mount: "/mnt/data dir",
				fs: "xfs",
				total: 2000000 * 1024,
				used: 1800000 * 1024,
				avail: 200000 * 1024,
			},
		]);
	});

	it("collapses a bind-mounted file of the root fs (containerized host)", () => {
		const df = [
			"Filesystem     Type    1024-blocks      Used Available Capacity Mounted on",
			"overlay        overlay  347865088 175149644 172715444      51% /",
			"/dev/vdb1      btrfs    347865088 175149644 172715444      51% /etc/hosts",
		].join("\n");
		expect(parseDf(df, filter).map((disk) => disk.mount)).toEqual(["/"]);
	});

	it("drops file bind mounts even when their numbers drift from /", () => {
		// Writes between df's lines make the two rows differ, so the
		// same-numbers dedupe alone let /etc/hosts into the history.
		const df = [
			"Filesystem     Type    1024-blocks      Used Available Capacity Mounted on",
			"overlay        overlay  347865088 175149644 172715444      51% /",
			"/dev/vdb1      btrfs    347865088 175149700 172715388      51% /etc/hosts",
		].join("\n");
		expect(parseDf(df, filter).map((disk) => disk.mount)).toEqual(["/"]);
	});

	it("uses one mount filter for samples and stored history", () => {
		expect(isReportedMount("/", filter)).toBe(true);
		expect(isReportedMount("/mnt/data", filter)).toBe(true);
		expect(isReportedMount("/etc/hosts", filter)).toBe(false);
		expect(isReportedMount("/run", filter)).toBe(false);
		expect(isReportedMount("/var/lib/docker/overlay2/x", filter)).toBe(false);
		expect(isReportedMount("relative", filter)).toBe(false);
	});

	it("computes usage like df (used / (used + available))", () => {
		expect(diskPercent({ used: 90, avail: 10 })).toBe(90);
		expect(diskPercent({ used: 0, avail: 0 })).toBe(0);
	});
});

describe("docker stats JSON", () => {
	it("parses sizes with decimal and binary units", () => {
		expect(parseSize("648B")).toBe(648);
		expect(parseSize("1.3kB")).toBe(1300);
		expect(parseSize("7.855MiB")).toBe(Math.round(7.855 * 1024 ** 2));
		expect(parseSize("15.66GiB")).toBe(Math.round(15.66 * 1024 ** 3));
		expect(parseSize("2.05GB")).toBe(2.05e9);
		expect(parseSize("--")).toBeNull();
	});

	it("parses one object per line and skips junk", () => {
		const out = [
			'{"BlockIO":"147kB / 65.5kB","CPUPerc":"1.25%","Container":"fee9","ID":"fee9","MemPerc":"0.05%","MemUsage":"8MiB / 1GiB","Name":"app-web","NetIO":"1.5kB / 648B","PIDs":"7"}',
			"not json",
			'{"CPUPerc":"--","MemUsage":"0B / 0B","Name":"/stopped","NetIO":"0B / 0B"}',
			'{"CPUPerc":"1%"}',
		].join("\n");
		expect(parseDockerStats(out)).toEqual([
			{
				name: "app-web",
				cpuPercent: 1.25,
				memUsed: 8 * 1024 ** 2,
				memLimit: 1024 ** 3,
				netRx: 1500,
				netTx: 648,
			},
			{
				name: "stopped",
				cpuPercent: null,
				memUsed: 0,
				memLimit: 0,
				netRx: 0,
				netTx: 0,
			},
		]);
	});
});

describe("docker inspect rows", () => {
	it("parses the tab separated format with optional labels and health", () => {
		const out = [
			"/pb-1e2c-pocketbase\t1e2cc0b3-277c-4675-a209-2aa0abe3726a\tpocketbase\trunning\thealthy\t0\tpocketbase-1e2cc0b3",
			"/nitrobase-traefik\t\t\trunning\t\t2",
			"/odd\t<no value>\t<no value>\trestarting\t\t7",
			"broken line",
		].join("\n");
		expect(parseDockerInspect(out)).toEqual([
			{
				name: "pb-1e2c-pocketbase",
				appLabel: "1e2cc0b3-277c-4675-a209-2aa0abe3726a",
				service: "pocketbase",
				state: "running",
				health: "healthy",
				restartCount: 0,
				project: "pocketbase-1e2cc0b3",
			},
			{
				name: "nitrobase-traefik",
				appLabel: null,
				service: null,
				state: "running",
				health: null,
				restartCount: 2,
				project: null,
			},
			{
				name: "odd",
				appLabel: null,
				service: null,
				state: "restarting",
				health: null,
				restartCount: 7,
				project: null,
			},
		]);
	});

	it("reads the last exit code (BUG-015)", () => {
		const [exited, oneShot] = parseDockerInspect(
			[
				"/aw-postgresql\tapp-1\tpostgresql\texited\t\t0\taw\tfalse\t137",
				"/aw-migrate\tapp-1\tmigrate\texited\t\t0\taw\tfalse\t0",
			].join("\n"),
		);
		expect(exited).toMatchObject({ state: "exited", exitCode: 137 });
		expect(oneShot).toMatchObject({ state: "exited", exitCode: 0 });
	});
});
