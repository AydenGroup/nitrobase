import { APP_ID } from "#/config/shared.ts";

/**
 * Machine identifiers the panel writes on servers, files and requests:
 * Docker labels, resource name prefixes, HTTP headers, file names. All
 * come from one prefix (client-safe, no I/O).
 *
 * These are persisted: containers, networks, images and webhook senders
 * carry them, so the prefix is NOT the display name (`APP_NAME` can be
 * rebranded freely). Env-tunable names (containers, networks, paths) live
 * in `#/config/server.ts`.
 */
export const RESOURCE_PREFIX = APP_ID;

/** Label names under the prefix (`<prefix>.<name>`). */
const LABEL_NAMES = {
	/** App id on every container/volume of an app (and its built images). */
	app: "app",
	/** Compose service of a container. */
	service: "service",
	/**
	 * `true` on a service Traefik routes to: it must be attached to the
	 * shared proxy network (by container name only, see apps/networks.ts).
	 */
	routed: "routed",
	/** Owning panel instance (split-brain guard). */
	instance: "instance",
	/** Link id on a database link network. */
	link: "link",
	/** Commit an image was built from. */
	commit: "commit",
	/** Hash of a managed container's configuration (recreate on change). */
	configHash: "config-hash",
	/** Traefik of a server reachable only through its tunnel. */
	tunnelOnly: "tunnel-only",
	/** Deployment id of a panel updater container. */
	upgrade: "upgrade",
} as const;

export type DockerLabel = keyof typeof LABEL_NAMES;

/** Docker label keys the panel writes (containers, images, networks). */
export const DOCKER_LABELS = Object.fromEntries(
	Object.entries(LABEL_NAMES).map(([key, name]) => [
		key,
		`${RESOURCE_PREFIX}.${name}`,
	]),
) as unknown as {
	readonly [K in DockerLabel]: `${typeof RESOURCE_PREFIX}.${(typeof LABEL_NAMES)[K]}`;
};

/** `docker inspect` lookup of a label key (a missing key reads as ""). */
const inspectLabel = (key: string) => `index .Config.Labels "${key}"`;
/** `docker ps` / `docker volume ls` / `docker network ls` lookup. */
export const listLabel = (key: string) => `.Label "${key}"`;

/** `{{<lookup of label>}}`: a whole `--format` / `-f` template. */
export const labelValueTemplate = (
	label: DockerLabel,
	access: (key: string) => string = inspectLabel,
) => `{{${access(DOCKER_LABELS[label])}}}`;

/** `--filter` value matching `label` (optionally `=value`). */
export const labelFilter = (label: DockerLabel, value?: string) =>
	value === undefined
		? `label=${DOCKER_LABELS[label]}`
		: `label=${DOCKER_LABELS[label]}=${value}`;

/** True for a label key under the panel prefix (users may not set these). */
export const isReservedLabel = (key: string) =>
	key.toLowerCase().startsWith(`${RESOURCE_PREFIX}.`);

/** `<prefix>-<name>`: Docker resources and temp names the panel creates. */
export const resourceName = (name: string) => `${RESOURCE_PREFIX}-${name}`;

/** `.<prefix>-<name>`: hidden helper files next to user data. */
export const hiddenFileName = (name: string) => `.${RESOURCE_PREFIX}-${name}`;

/** Headers of signed webhooks the panel sends and its generic push hook. */
export const WEBHOOK_HEADERS = {
	signature: `x-${RESOURCE_PREFIX}-signature`,
	timestamp: `x-${RESOURCE_PREFIX}-timestamp`,
	event: `x-${RESOURCE_PREFIX}-event`,
	delivery: `x-${RESOURCE_PREFIX}-delivery`,
} as const;

/** Browser storage keys (per viewer) the panel writes: `<prefix>.<name>`. */
export const storageKey = (name: string) => `${RESOURCE_PREFIX}.${name}`;

/** File name of a download: `<prefix>-<name>`. */
export const downloadName = (name: string) => resourceName(name);
