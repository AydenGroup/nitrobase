import {
	hiddenFileName,
	labelFilter,
	labelValueTemplate,
	RESOURCE_PREFIX,
} from "#/config/identifiers.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { assertSlug } from "#/server/services/templates/naming.ts";
import { internalError } from "#/utils/error.ts";
import type { AppLocation } from "./commands";

/**
 * Shared networks of app containers (pure, tested): the proxy network
 * (`NITROBASE_NETWORK`, Traefik and the health probe) and database link
 * networks. Docker Compose registers a container on every network its
 * compose file names under the *service* name too (`kong`, `db`...), so
 * two apps with a same-named service on one shared network resolve each
 * other's containers (BUG-006: one app's Studio sending its service-role
 * key to another app's Kong). The compose files therefore never name a
 * shared network: after every `up`/`create`/`start` the deploy attaches
 * the listed containers with `docker network connect`, which registers
 * only the container's own name (and short id), and nothing else needs
 * the service names there (Traefik, the probe and links use container
 * names).
 *
 * The list is the app's `APP_NETWORKS_FILE`, written with its compose
 * file (`container<TAB>network` per line); the app folder and this file
 * cannot be mounted into containers (reserved entries).
 */

/** Attachments file in the app folder. */
export const APP_NETWORKS_FILE = hiddenFileName("networks");

export interface NetworkAttachment {
	container: string;
	network: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function assertName(value: string): string {
	if (!NAME.test(value)) throw internalError(`Invalid name "${value}"`);
	return value;
}

/** Content of `APP_NETWORKS_FILE`. */
export function renderNetworksFile(attachments: NetworkAttachment[]): string {
	return attachments
		.map(
			({ container, network }) =>
				`${assertName(container)}\t${assertName(network)}\n`,
		)
		.join("");
}

/** A container's network names, one per line. */
const NETWORK_NAMES =
	"{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}";

/**
 * Attach the app's containers listed in its `APP_NETWORKS_FILE` to their
 * networks (no alias), skipping attached and missing containers. Fails
 * when an attach fails. Only containers of this app (named `<folder>-…`
 * and labelled `nitrobase.app=<app id>`; another one squatting the name
 * fails the command) and plain network names are accepted from the file.
 * Idempotent; no file (an app deployed before this file existed) is a
 * no-op.
 */
export function attachNetworksScript(location: AppLocation): string {
	const folder = assertSlug(location.folder);
	if (!location.appId)
		throw internalError("App id required to attach networks");
	const appId = assertName(location.appId);
	return [
		"(",
		`f=${q(`${location.appRoot}/${APP_NETWORKS_FILE}`)}`,
		'[ -f "$f" ] || exit 0',
		`on() { docker inspect -f ${q(NETWORK_NAMES)} "$1" 2>/dev/null | grep -qxF -- "$2"; }`,
		"failed=0",
		"while read -r c n; do",
		`  case "$c" in ${q(`${folder}-`)}*) ;; *) continue ;; esac`,
		'  case "$n" in ""|*[!A-Za-z0-9_.-]*) continue ;; esac',
		'  docker container inspect "$c" >/dev/null 2>&1 || continue',
		`  if [ "$(docker inspect -f ${q(labelValueTemplate("app"))} "$c")" != ${q(appId)} ]; then echo "Not attaching $c: not a container of this app" >&2; failed=1; continue; fi`,
		'  on "$c" "$n" && continue',
		'  docker network connect "$n" "$c" >/dev/null 2>&1 || on "$c" "$n" || { echo "Could not attach $c to network $n" >&2; failed=1; }',
		'done < "$f"',
		'exit "$failed"',
		")",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Repairs: re-attach a routed container found off the proxy network, and
// drop service-name aliases a compose file of an earlier version (or a
// manual `docker compose up` with one) registered there.

/**
 * `docker inspect` fields describing a container's place on the proxy
 * network, tab separated (see `parseNetworkState`): short id, owner label,
 * routed label, attached networks (comma separated), aliases on `network`.
 *
 * Fields use the Go struct names (`.ID`, not the JSON key `.Id`): Docker
 * runs the template on the typed inspect result and, when that fails,
 * again on the raw JSON, where a container without a healthcheck has no
 * `State.Health` key and `{{if .State.Health}}` errors: the container was
 * left out of the whole line set (BUG-016).
 */
export function networkStateFields(network: string): string[] {
	assertName(network);
	return [
		"{{.ID}}",
		labelValueTemplate("instance"),
		labelValueTemplate("routed"),
		"{{range $k, $v := .NetworkSettings.Networks}}{{$k}},{{end}}",
		`{{with index .NetworkSettings.Networks "${network}"}}{{join .Aliases ","}}{{end}}`,
	];
}

export interface ContainerNetworkState {
	name: string;
	/** Full container id. */
	id: string | null;
	/** `nitrobase.app` label. */
	appLabel: string | null;
	/** Owner (instance) label. */
	owner: string | null;
	routed: boolean;
	networks: string[];
	/** Aliases on the proxy network. */
	aliases: string[];
}

const clean = (value: string | undefined) =>
	value && value !== "<no value>" ? value : null;
const list = (value: string | undefined) =>
	(value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item && item !== "<no value>");

/** The `networkStateFields` part of an inspect line. */
export function parseNetworkState(
	name: string,
	appLabel: string | null,
	fields: string[],
): ContainerNetworkState {
	const [id, owner, routed, networks, aliases] = fields.map((f) => f.trim());
	return {
		name: name.replace(/^\//, ""),
		id: clean(id),
		appLabel,
		owner: clean(owner),
		routed: routed === "true",
		networks: list(networks),
		aliases: list(aliases),
	};
}

/** Script listing this panel's app containers (`NETWORK_STATE_FORMAT`). */
export function networkStateScript(
	network: string,
	instanceId: string,
): string {
	assertName(instanceId);
	const format = [
		"{{.Name}}",
		labelValueTemplate("app"),
		...networkStateFields(network),
	].join("\t");
	return [
		`ids=$(docker ps -aq --no-trunc --filter ${q(labelFilter("instance", instanceId))} --filter ${q(labelFilter("app"))})`,
		'[ -n "$ids" ] || exit 0',
		`docker inspect --format ${q(format)} $ids 2>/dev/null`,
		"exit 0",
	].join("\n");
}

/** Lines of `networkStateScript`. */
export function parseNetworkStateLines(
	output: string,
): ContainerNetworkState[] {
	const rows: ContainerNetworkState[] = [];
	for (const line of output.split("\n")) {
		const [name = "", app, ...fields] = line.split("\t");
		// Trailing empty fields (no aliases, often no networks) may be
		// trimmed off the last line: the id is always there.
		if (!name.trim() || !fields[0]?.trim()) continue;
		rows.push(parseNetworkState(name.trim(), clean(app?.trim()), fields));
	}
	return rows;
}

/**
 * Aliases besides the container's own name and short id: names Compose
 * registered (the service name, `<project>-<service>-1`, template aliases).
 */
export function foreignAliases(row: ContainerNetworkState): string[] {
	return row.aliases.filter(
		(alias) =>
			alias !== row.name &&
			!(/^[0-9a-f]{12,64}$/.test(alias) && row.id?.startsWith(alias)),
	);
}

export interface NetworkRepair {
	/** `attach`: routed but off the network; `realias`: drop compose aliases. */
	action: "attach" | "realias";
	container: string;
	/** The container's app (`nitrobase.app`): repairs wait while it has a job. */
	appId?: string | null;
}

export interface RepairGuard {
	/** Repairs to run this tick. */
	run: NetworkRepair[];
	/** Containers given up on -> consecutive ticks they needed the repair. */
	flapping: Map<string, number>;
	/** Streaks to keep for the next tick. */
	streak: Map<string, number>;
}

/**
 * Flap guard: a container that needs the same repair on more than
 * `maxAttempts` consecutive ticks (something keeps detaching or
 * re-aliasing it) is not reconnected every tick any more; it is reported
 * instead (monitoring alert `network_flap`). The streak ends, and repairs
 * resume, once a tick no longer finds it wrong.
 */
export function guardNetworkRepairs(
	planned: NetworkRepair[],
	previous: ReadonlyMap<string, number>,
	maxAttempts: number,
): RepairGuard {
	const streak = new Map<string, number>();
	const run: NetworkRepair[] = [];
	const flapping = new Map<string, number>();
	for (const repair of planned) {
		const key = `${repair.action}:${repair.container}`;
		const count = (previous.get(key) ?? 0) + 1;
		streak.set(key, count);
		if (count > maxAttempts) flapping.set(repair.container, count);
		else run.push(repair);
	}
	return { run, flapping, streak };
}

/**
 * Repairs on the proxy network, for this panel's app containers only:
 * re-attach routed containers that left it, re-attach (disconnect +
 * connect, a sub-second interruption) those registered under names other
 * than their own.
 */
export function planNetworkRepairs(
	rows: ContainerNetworkState[],
	settings: { instanceId: string | null; network: string },
): NetworkRepair[] {
	if (!settings.instanceId) return [];
	const out: NetworkRepair[] = [];
	for (const row of rows) {
		if (row.owner !== settings.instanceId || !row.appLabel) continue;
		if (!NAME.test(row.name)) continue;
		const attached = row.networks.includes(settings.network);
		if (attached && foreignAliases(row).length > 0) {
			out.push({ action: "realias", container: row.name, appId: row.appLabel });
		} else if (!attached && row.routed) {
			out.push({ action: "attach", container: row.name, appId: row.appLabel });
		}
	}
	return out;
}

/** Shell for `repairs`; prints `repaired|failed <action> <container>`. */
export function networkRepairScript(
	network: string,
	repairs: NetworkRepair[],
): string | null {
	if (repairs.length === 0) return null;
	const net = q(assertName(network));
	return [
		`on() { docker inspect -f ${q(NETWORK_NAMES)} "$1" 2>/dev/null | grep -qxF -- ${net}; }`,
		...repairs.map(({ action, container }) => {
			const c = q(assertName(container));
			const drop =
				action === "realias"
					? `docker network disconnect ${net} ${c} >/dev/null 2>&1; `
					: "";
			return `${drop}if docker network connect ${net} ${c} >/dev/null 2>&1 || on ${c}; then echo ${q(`repaired ${action} ${container}`)}; else echo ${q(`failed ${action} ${container}`)}; fi`;
		}),
	].join("\n");
}

export interface NetworkRepairResult extends NetworkRepair {
	ok: boolean;
}

export function parseNetworkRepairs(output: string): NetworkRepairResult[] {
	const out: NetworkRepairResult[] = [];
	for (const line of output.split("\n")) {
		const match = /^(repaired|failed) (attach|realias) (\S+)$/.exec(
			line.trim(),
		);
		if (!match) continue;
		out.push({
			ok: match[1] === "repaired",
			action: match[2] as NetworkRepair["action"],
			container: match[3],
		});
	}
	return out;
}

/** Compose key of the proxy or a link network. */
const SHARED_NETWORK_KEY = new RegExp(
	`\\b${RESOURCE_PREFIX}_(?:proxy|link_[0-9a-f]+)\\b`,
);

/**
 * The deployed compose of an app names the proxy or a link network: it was
 * deployed before shared networks were attached by container name, and a
 * `docker compose up` from its files would register the service names
 * again. Cleared by the next deploy (or the migration's file rewrite);
 * shown as "Redeploy to finish the network fix" meanwhile.
 */
export function declaresSharedNetworks(compose: string | null): boolean {
	return !!compose && SHARED_NETWORK_KEY.test(compose);
}

/**
 * What the migration does with an app's files: nothing (already fine),
 * `refresh` (re-render and upload: its stored state is what runs), or
 * `skip` (changes wait for a redeploy, or it is not settled: the files are
 * left and the app shows "Redeploy to finish the network fix").
 */
export function networkFileAction(app: {
	composeDeployed: string | null;
	status: string;
	needsRedeploy: boolean;
	envPendingAt: Date | null;
}): "none" | "refresh" | "skip" {
	if (!declaresSharedNetworks(app.composeDeployed)) return "none";
	const settled =
		(app.status === "running" || app.status === "stopped") &&
		!app.needsRedeploy &&
		!app.envPendingAt;
	return settled ? "refresh" : "skip";
}
