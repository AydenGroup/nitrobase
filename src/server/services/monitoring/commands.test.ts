import { describe, expect, it } from "vitest";
import {
	combineCollectorCommands,
	containerStatsScript,
	inspectFormat,
	serverStatsScript,
	splitCollectorOutput,
	splitSections,
} from "./commands";

describe("collector commands", () => {
	it("reads /proc and df in one script", () => {
		expect(serverStatsScript()).toBe(
			[
				"printf '\\n@@nitrobase-section %s\\n' stat; head -n 1 /proc/stat",
				"printf '\\n@@nitrobase-section %s\\n' loadavg; cat /proc/loadavg",
				"printf '\\n@@nitrobase-section %s\\n' meminfo; cat /proc/meminfo",
				"printf '\\n@@nitrobase-section %s\\n' netdev; cat /proc/net/dev",
				"printf '\\n@@nitrobase-section %s\\n' uptime; cat /proc/uptime",
				"printf '\\n@@nitrobase-section %s\\n' df; df -kPT",
			].join("\n"),
		);
	});

	it("inspects labels/state only and samples stats once", () => {
		expect(containerStatsScript()).toBe(
			[
				"command -v docker >/dev/null 2>&1 || exit 0",
				"ids=$(docker ps -aq --no-trunc)",
				'[ -n "$ids" ] || exit 0',
				'printf \'\\n@@nitrobase-section %s\\n\' inspect; docker inspect --format \'{{.Name}}\t{{index .Config.Labels "nitrobase.app"}}\t{{index .Config.Labels "nitrobase.service"}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.RestartCount}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{.State.OOMKilled}}\t{{.State.ExitCode}}\' $ids',
				"printf '\\n@@nitrobase-section %s\\n' stats; docker stats --no-stream --no-trunc --format '{{json .}}'",
			].join("\n"),
		);
	});

	it("reads only typed inspect fields (BUG-016)", () => {
		// A field Docker cannot resolve on the typed result (`.Id`) makes it
		// retry on the raw JSON, where `.State.Health` is missing without a
		// healthcheck: those containers vanished from the output.
		const format = inspectFormat("nitrobase-network");
		expect(format).toContain("{{.ID}}");
		expect(format).not.toMatch(/\.Id\b/);
	});

	it("runs every collector in its own subshell of one command", () => {
		expect(
			combineCollectorCommands([
				{ id: "server", command: "echo a" },
				{ id: "containers", command: "exit 0" },
			]),
		).toBe(
			[
				"printf '\\n@@nitrobase-collector %s\\n' server",
				"( echo a",
				") 2>/dev/null",
				"printf '\\n@@nitrobase-collector %s\\n' containers",
				"( exit 0",
				") 2>/dev/null",
			].join("\n"),
		);
	});

	it("rejects ids that could break the script", () => {
		expect(() =>
			combineCollectorCommands([{ id: "x; rm -rf /", command: "true" }]),
		).toThrow();
	});

	it("splits output back per collector and section", () => {
		const output =
			"\n@@nitrobase-collector server\n\n@@nitrobase-section stat\ncpu 1 2 3 4\n\n@@nitrobase-section df\nFilesystem\n\n@@nitrobase-collector containers\n";
		const collectors = splitCollectorOutput(output);
		expect([...collectors.keys()]).toEqual(["server", "containers"]);
		expect(collectors.get("containers")).toBe("");
		const sections = splitSections(collectors.get("server") ?? "");
		expect(sections.get("stat")).toBe("cpu 1 2 3 4");
		expect(sections.get("df")).toBe("Filesystem");
	});
});
