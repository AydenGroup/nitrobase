import type {
	DatabaseEngineId,
	DatabaseUrlPart,
} from "#/config/database-engines.ts";
import { DOCKER_LABELS, labelFilter } from "#/config/identifiers.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { OWNER_LABEL } from "#/server/services/ownership.ts";
import {
	LINK_NETWORK_KEY_PREFIX,
	LINK_NETWORK_NAME_PREFIX,
	type LinkNetwork,
} from "#/server/services/templates/compose-policy.ts";
import {
	ENV_NAME_PATTERN,
	RESERVED_ENV_PATTERN,
	TemplateError,
} from "#/server/services/templates/naming.ts";
import { internalError } from "#/utils/error.ts";
import { connectionUrl, type DatabaseEndpoint, urlParts } from "./connection";
import type { DatabaseLogin } from "./engines";

/**
 * Database links (pure, tested). A link gives one app's services the
 * database's connection env and a private network shared only by the
 * database service and that app (`docker network create --internal`,
 * labelled with the panel's instance id). No compose file names it (the
 * policy refuses its reserved key and name): Compose would register the
 * service names there, and the database's `db` would collide with a
 * linked app's own `db`. Both sides' containers are attached after every
 * `up` by container name only (`apps/networks.ts`); the database joins a
 * new link at once (`connectNetworkCommand`).
 */

/** Label holding the link id on a link network. */
const LINK_LABEL = DOCKER_LABELS.link;

/** One env var of a link: the full URL or one part of it. */
export interface LinkEnvEntry {
	name: string;
	part: "url" | DatabaseUrlPart;
}

const hex = (linkId: string) => {
	const value = linkId.replace(/-/g, "").toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(value)) {
		throw internalError("Invalid link id");
	}
	return value;
};

export function linkNetworkName(linkId: string): string {
	return `${LINK_NETWORK_NAME_PREFIX}${hex(linkId)}`;
}

/** The network of a link, joined by `services` of one side. */
export function linkNetwork(
	linkId: string,
	services: string[] | "all",
): LinkNetwork {
	return {
		key: `${LINK_NETWORK_KEY_PREFIX}${hex(linkId)}`,
		name: linkNetworkName(linkId),
		services,
	};
}

/** Env names a link may set (no Docker Compose names). */
export function assertLinkEnvName(name: string): string {
	if (!ENV_NAME_PATTERN.test(name) || RESERVED_ENV_PATTERN.test(name)) {
		throw new TemplateError("DATABASE_LINK_ENV_INVALID", { name });
	}
	return name;
}

/** The env values a linked app gets (parts with no value are left out). */
export function renderLinkEnv(
	engine: DatabaseEngineId,
	endpoint: DatabaseEndpoint,
	login: DatabaseLogin,
	entries: LinkEnvEntry[],
): Record<string, string> {
	const parts = urlParts(endpoint, login);
	const out: Record<string, string> = {};
	for (const entry of entries) {
		const value =
			entry.part === "url"
				? connectionUrl(engine, endpoint, login)
				: parts[entry.part];
		if (value !== null) out[assertLinkEnvName(entry.name)] = value;
	}
	return out;
}

/** A link network name. */
const NAME = new RegExp(`^${LINK_NETWORK_NAME_PREFIX}[0-9a-f]{32}$`);
const CONTAINER = /^[a-z0-9][a-z0-9_.-]*$/;

function assertNetwork(name: string): string {
	if (!NAME.test(name)) throw internalError(`Invalid network ${name}`);
	return name;
}

function assertInstance(instanceId: string): string {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(instanceId)) {
		throw internalError("Invalid instance id");
	}
	return instanceId;
}

/**
 * Create missing link networks (internal: no route out; labelled so only
 * this panel ever removes them). Idempotent.
 */
export function ensureLinkNetworksCommand(
	networks: { name: string; linkId: string }[],
	instanceId: string,
): string | null {
	if (networks.length === 0) return null;
	const owner = assertInstance(instanceId);
	return networks
		.map(({ name, linkId }) => {
			const network = q(assertNetwork(name));
			return `{ docker network inspect ${network} >/dev/null 2>&1 || docker network create --internal --label ${q(`${OWNER_LABEL}=${owner}`)} --label ${q(`${LINK_LABEL}=${hex(linkId)}`)} ${network} >/dev/null; }`;
		})
		.join(" && ");
}

/** Attach a running container to a link network (no-op when attached). */
export function connectNetworkCommand(
	network: string,
	container: string,
): string {
	if (!CONTAINER.test(container)) throw internalError("Invalid container");
	const name = q(assertNetwork(network));
	return `docker inspect -f '{{json .NetworkSettings.Networks}}' ${q(container)} | grep -q ${q(`"${network}"`)} || docker network connect ${name} ${q(container)}`;
}

/** Detach every container from a link network and remove it (best effort). */
export function removeLinkNetworkCommand(network: string): string {
	const name = q(assertNetwork(network));
	return `if docker network inspect ${name} >/dev/null 2>&1; then for c in $(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' ${name}); do docker network disconnect -f ${name} "$c" >/dev/null 2>&1 || true; done; docker network rm ${name} >/dev/null 2>&1 || true; fi`;
}

/** Detach one container from a link network (best effort). */
export function disconnectNetworkCommand(
	network: string,
	container: string,
): string {
	if (!CONTAINER.test(container)) throw internalError("Invalid container");
	return `docker network disconnect -f ${q(assertNetwork(network))} ${q(container)} >/dev/null 2>&1 || true`;
}

/**
 * Remove this panel's link networks that no link uses any more and no
 * container is attached to (left by an unlink while the app was stopped,
 * or a deleted app). `docker network rm` refuses networks in use.
 */
export function pruneLinkNetworksCommand(
	keep: string[],
	instanceId: string,
): string {
	const owner = assertInstance(instanceId);
	const kept = [...new Set(keep.map(assertNetwork))];
	const filter = kept.length
		? ` | grep -vxF ${kept.map((name) => `-e ${q(name)}`).join(" ")}`
		: "";
	const list = `docker network ls --filter ${q(labelFilter("instance", owner))} --filter ${q(labelFilter("link"))} --format '{{.Name}}'`;
	return `for n in $(${list}${filter}); do docker network rm "$n" >/dev/null 2>&1 || true; done`;
}
