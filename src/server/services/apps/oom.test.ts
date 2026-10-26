import { describe, expect, it } from "vitest";
import { composeOomCommand } from "./commands.ts";
import { OOM_NOW_PREFIX, parseOomKills } from "./oom.ts";

/**
 * A container the kernel killed for memory (`State.OOMKilled`) under a
 * memory limit: the deploy names it, since "unhealthy" alone hides why.
 */

const MIB = 1024 * 1024;
const row = (service: string, killed: string, bytes: number | string) =>
	[service, killed, String(bytes)].join("\t");

describe("parseOomKills", () => {
	it("lists the services killed under a memory limit", () => {
		const output = [
			row("db", "false", 0),
			row("kong", "true", 64 * MIB),
			row("auth", "false", 512 * MIB),
		].join("\n");
		expect(parseOomKills(output)).toEqual([{ service: "kong", limitMb: 64 }]);
	});

	it("skips a kill without a limit (the host ran out, not the limit)", () => {
		expect(parseOomKills(row("kong", "true", 0))).toEqual([]);
	});

	it("keeps one entry per service (replicas)", () => {
		const output = [
			row("worker", "true", 128 * MIB),
			row("worker", "true", 128 * MIB),
		].join("\n");
		expect(parseOomKills(output)).toEqual([
			{ service: "worker", limitMb: 128 },
		]);
	});

	it("ignores blank and malformed lines", () => {
		const output = `\nnot a row\n${row("kong", "true", 64 * MIB)}\n`;
		expect(parseOomKills(output)).toEqual([{ service: "kong", limitMb: 64 }]);
	});

	it("rounds the limit to whole MiB", () => {
		expect(parseOomKills(row("kong", "true", 64.4 * MIB))).toEqual([
			{ service: "kong", limitMb: 64 },
		]);
	});
});

describe("parseOomKills within a window", () => {
	const now = Date.parse("2026-10-21T12:00:00Z") / 1000;
	const at = (service: string, finishedAt: string) =>
		`${row(service, "true", 64 * MIB)}\t${finishedAt}`;
	const output = (...rows: string[]) =>
		[`${OOM_NOW_PREFIX}\t${now}`, ...rows].join("\n");

	it("keeps kills that ended inside the window, on the host's clock", () => {
		expect(
			parseOomKills(
				output(
					at("kong", "2026-10-21T11:59:30.123456789Z"),
					at("auth", "2026-10-21T10:00:00.5Z"),
				),
				{ withinSeconds: 60 },
			),
		).toEqual([{ service: "kong", limitMb: 64 }]);
	});

	it("keeps every kill without a window", () => {
		expect(
			parseOomKills(output(at("auth", "2026-10-21T10:00:00Z"))),
		).toHaveLength(1);
	});

	it("keeps a kill whose time is unknown (a hint never hides a cause)", () => {
		expect(
			parseOomKills(output(at("kong", "0001-01-01T00:00:00Z")), {
				withinSeconds: 60,
			}),
		).toHaveLength(1);
		expect(
			parseOomKills(at("kong", "2026-10-21T10:00:00Z"), { withinSeconds: 60 }),
		).toHaveLength(1);
	});

	it("does not read the now line as a service", () => {
		expect(parseOomKills(output())).toEqual([]);
	});
});

describe("composeOomCommand", () => {
	it("inspects the app's containers by compose project, labels and state only", () => {
		const command = composeOomCommand({
			appRoot: "/etc/nitrobase/apps/demo",
			folder: "demo",
		} as never);
		expect(command).toMatch(/-p '?demo'?/);
		expect(command).toContain("docker inspect");
		expect(command).toContain("State.OOMKilled");
		expect(command).toContain("HostConfig.Memory");
		expect(command).toContain("State.FinishedAt");
		expect(command).toContain("date +%s");
		// Never the config with the secrets.
		expect(command).not.toContain(".Config.Env");
	});
});
