import { labelValueTemplate } from "#/config/identifiers.ts";
import { APP_ID } from "#/config/shared.ts";
import { networkStateFields } from "#/server/services/apps/networks.ts";
import { shellQuote } from "#/server/services/executor.ts";
import { internalError } from "#/utils/error.ts";

/**
 * Remote command building for the collectors. Every tick runs ONE command
 * per server: each collector's script runs in its own subshell (stderr
 * dropped, so a missing tool can't break the others) after a marker line.
 */

const COLLECTOR_MARKER = `@@${APP_ID}-collector`;
const SECTION_MARKER = `@@${APP_ID}-section`;

const ID = /^[a-z][a-z0-9-]*$/;

function assertId(id: string): string {
	if (!ID.test(id)) throw internalError(`Invalid collector/section id ${id}`);
	return id;
}

/** Script printing `@@<APP_ID>-section <id>` before each part's output. */
function sectionsScript(parts: { id: string; command: string }[]) {
	return parts
		.map(
			({ id, command }) =>
				`printf '\\n${SECTION_MARKER} %s\\n' ${assertId(id)}; ${command}`,
		)
		.join("\n");
}

/** Split output produced by `sectionsScript` (or the combined command). */
export function splitSections(
	text: string,
	marker: string = SECTION_MARKER,
): Map<string, string> {
	const out = new Map<string, string>();
	let current: string | null = null;
	let lines: string[] = [];
	const flush = () => {
		if (current !== null) out.set(current, lines.join("\n").trim());
	};
	for (const line of text.split("\n")) {
		if (line.startsWith(`${marker} `)) {
			flush();
			current = line.slice(marker.length + 1).trim();
			lines = [];
			continue;
		}
		if (current !== null) lines.push(line);
	}
	flush();
	return out;
}

/** One command for all collectors of a tick. */
export function combineCollectorCommands(
	collectors: { id: string; command: string }[],
): string {
	return collectors
		.map(
			({ id, command }) =>
				`printf '\\n${COLLECTOR_MARKER} %s\\n' ${assertId(id)}\n( ${command}\n) 2>/dev/null`,
		)
		.join("\n");
}

export function splitCollectorOutput(text: string): Map<string, string> {
	return splitSections(text, COLLECTOR_MARKER);
}

/** /proc + df in one script (GNU df: `-T` adds the filesystem type). */
export function serverStatsScript(): string {
	return sectionsScript([
		{ id: "stat", command: "head -n 1 /proc/stat" },
		{ id: "loadavg", command: "cat /proc/loadavg" },
		{ id: "meminfo", command: "cat /proc/meminfo" },
		{ id: "netdev", command: "cat /proc/net/dev" },
		{ id: "uptime", command: "cat /proc/uptime" },
		{ id: "df", command: "df -kPT" },
	]);
}

/**
 * `docker inspect` fields, tab separated (see `parseDockerInspect`): name,
 * app label, service label, state, health (empty without a healthcheck),
 * restart count, compose project, OOM kill, last exit code. Labels and
 * state only: never env or config with secrets.
 */
const INSPECT_FORMAT = [
	"{{.Name}}",
	labelValueTemplate("app"),
	labelValueTemplate("service"),
	"{{.State.Status}}",
	"{{if .State.Health}}{{.State.Health.Status}}{{end}}",
	"{{.RestartCount}}",
	'{{index .Config.Labels "com.docker.compose.project"}}',
	"{{.State.OOMKilled}}",
	"{{.State.ExitCode}}",
].join("\t");

/**
 * `INSPECT_FORMAT`, plus the container's place on the proxy network
 * (`networkStateFields`: re-attach / alias repairs) when one is given.
 */
export function inspectFormat(proxyNetwork?: string): string {
	return proxyNetwork
		? [INSPECT_FORMAT, ...networkStateFields(proxyNetwork)].join("\t")
		: INSPECT_FORMAT;
}

/** Container state/health (all containers) and usage (running ones). */
export function containerStatsScript(proxyNetwork?: string): string {
	return [
		"command -v docker >/dev/null 2>&1 || exit 0",
		"ids=$(docker ps -aq --no-trunc)",
		'[ -n "$ids" ] || exit 0',
		sectionsScript([
			{
				id: "inspect",
				command: `docker inspect --format ${shellQuote(inspectFormat(proxyNetwork))} $ids`,
			},
			{
				id: "stats",
				command: `docker stats --no-stream --no-trunc --format ${shellQuote("{{json .}}")}`,
			},
		]),
	].join("\n");
}
