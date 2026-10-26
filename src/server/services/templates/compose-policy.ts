import path from "node:path";
import {
	DOCKER_LABELS,
	hiddenFileName,
	isReservedLabel,
	RESOURCE_PREFIX,
	resourceName,
} from "#/config/identifiers.ts";
import type { ErrorCode } from "#/libs/error-codes.ts";
import type { AppErrorArgs } from "#/utils/error.ts";
import { OWNER_LABEL } from "../ownership";
import { TemplateError } from "./naming";
import { assertResources, type ServiceResources } from "./resources";

/** What a template explicitly allows (template.toml `[security]`). */
export interface ComposeAllowlist {
	privileged?: boolean;
	hostNetwork?: boolean;
	hostPid?: boolean;
	dockerSocket?: boolean;
	capAdd?: string[];
	devices?: string[];
	securityOpt?: string[];
	/** Absolute host paths that may be bind-mounted (exact match or prefix + "/"). */
	hostPaths?: string[];
	/** Names of external volumes/networks/configs/secrets that may be used. */
	external?: string[];
}

/** A container port the owner chose to publish on the host. */
export interface PublishedPort {
	service: string;
	/** Container port. */
	target: number;
	/** Host port. */
	published: number;
	/**
	 * Bind on the server's loopback only (127.0.0.1): reachable through an
	 * SSH tunnel, never from the network. Default: every interface.
	 */
	loopback?: boolean;
}

/**
 * A database link network (R3 M2): created by Nitrobase per link, joined by
 * the database service and the linked app's services only, so nothing
 * else reaches the database. Never named in a compose file (reserved key
 * and name): the containers are attached after `up` (`apps/networks.ts`).
 */
export interface LinkNetwork {
	/** Compose network key (`nitrobase_link_…`). */
	key: string;
	/** Docker network name (`nitrobase-link-…`). */
	name: string;
	/** Services that join it (`all`: every service with its own network stack). */
	services: string[] | "all";
}

/** Prefixes of the link network keys and Docker names the panel writes. */
export const LINK_NETWORK_KEY_PREFIX = `${RESOURCE_PREFIX}_link_`;
export const LINK_NETWORK_NAME_PREFIX = resourceName("link-");

/** Link id of a link network name (else null). */
export function parseLinkNetworkName(name: string): string | null {
	return name.startsWith(LINK_NETWORK_NAME_PREFIX) &&
		name.length > LINK_NETWORK_NAME_PREFIX.length
		? name.slice(LINK_NETWORK_NAME_PREFIX.length)
		: null;
}

/** Reserved (a compose file may not join a link network): keys and Docker names. */
export const isReservedLinkNetworkKey = (key: string) =>
	key.startsWith(LINK_NETWORK_KEY_PREFIX);
const isReservedLinkNetworkName = (name: string) =>
	name.startsWith(LINK_NETWORK_NAME_PREFIX);

/** Whether `service` joins `link` (pure; transform and policy agree). */
export function joinsLinkNetwork(link: LinkNetwork, service: string): boolean {
	return link.services === "all" || link.services.includes(service);
}

/** Host address of a published port (compose `host_ip`). */
const LOOPBACK_HOST = "127.0.0.1";

export interface ComposePolicyContext {
	appId: string;
	folder: string;
	appRoot: string;
	network: string;
	proxiedServices: string[];
	allow?: ComposeAllowlist;
	/** The only `ports` allowed (everything else is stripped / rejected). */
	publishedPorts?: PublishedPort[];
	/** This panel's instance id (container owner label), when known. */
	instanceId?: string;
	/** Resource limits Nitrobase sets per service (must stay in place). */
	resources?: Record<string, ServiceResources>;
	/**
	 * Limits for services that have none (server resource policy, see
	 * `servers.default_memory_mb`).
	 */
	fallbackResources?: ServiceResources;
	/** Database link networks this app joins (attached after `up`, never in the compose file). */
	linkNetworks?: LinkNetwork[];
}

/** Compose short syntax for a published port (TCP; loopback or all interfaces). */
export function publishedPortSpec(port: PublishedPort): string {
	return port.loopback
		? `${LOOPBACK_HOST}:${port.published}:${port.target}/tcp`
		: `${port.published}:${port.target}/tcp`;
}

/**
 * Parse one `ports` entry (short or long syntax) into host/target/protocol.
 * Returns null for anything that is not a plain single-port mapping.
 */
function parsePortEntry(entry: unknown): {
	hostIp: string;
	published: number;
	target: number;
	protocol: string;
} | null {
	if (typeof entry === "string") {
		const match =
			/^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/.exec(
				entry,
			);
		if (!match) return null;
		return {
			hostIp: match[1] ?? "",
			published: Number(match[2]),
			target: Number(match[3]),
			protocol: match[4] ?? "tcp",
		};
	}
	if (!isObj(entry)) return null;
	const allowedKeys = new Set([
		"target",
		"published",
		"protocol",
		"mode",
		"host_ip",
		"name",
		"app_protocol",
	]);
	if (Object.keys(entry).some((key) => !allowedKeys.has(key))) return null;
	const target = Number(entry.target);
	const published = Number(entry.published);
	if (!Number.isInteger(target) || !Number.isInteger(published)) return null;
	if (entry.mode !== undefined && entry.mode !== "ingress") return null;
	return {
		hostIp: typeof entry.host_ip === "string" ? entry.host_ip : "",
		published,
		target,
		protocol: typeof entry.protocol === "string" ? entry.protocol : "tcp",
	};
}

/** `ports` must be exactly the owner-enabled published ports of the service. */
function checkPorts(
	ports: unknown,
	ctx: ComposePolicyContext,
	service: string,
): void {
	const allowed = (ctx.publishedPorts ?? []).filter(
		(port) => port.service === service,
	);
	for (const entry of listOf(ports)) {
		const parsed = parsePortEntry(entry);
		const ok =
			parsed &&
			parsed.protocol === "tcp" &&
			allowed.some(
				(port) =>
					port.target === parsed.target &&
					port.published === parsed.published &&
					// Exactly the enabled binding: a loopback port may not widen.
					(port.loopback
						? parsed.hostIp === LOOPBACK_HOST
						: parsed.hostIp === "" || parsed.hostIp === "0.0.0.0"),
			);
		if (!ok) {
			fail("COMPOSE_PORT_NOT_ENABLED", {
				service,
				port: JSON.stringify(entry),
			});
		}
	}
}

/**
 * - `raw`: our transformed output, before compose interpolation. Any `$` in
 *   a security-relevant scalar is rejected, because `${X:-host}` would only
 *   become dangerous after interpolation.
 * - `resolved`: `docker compose config --format json` output (interpolated,
 *   merged, long syntax). Checked again right before `up` (defense in depth).
 */
export type PolicyMode = "raw" | "resolved";

type Obj = Record<string, unknown>;

export const PROXY_NETWORK_KEY = `${RESOURCE_PREFIX}_proxy`;
/** The proxy network key (reserved). */
export const isReservedProxyNetworkKey = (key: string) =>
	key === PROXY_NETWORK_KEY;
export const DOCKER_SOCKET = "/var/run/docker.sock";

const TOP_LEVEL_KEYS = new Set([
	"name",
	"version",
	"services",
	"volumes",
	"networks",
	"configs",
	"secrets",
]);

/** Service keys that are never allowed (host escape or host side effects). */
const DENIED_SERVICE_KEYS: Record<string, ErrorCode> = {
	provider: "COMPOSE_REASON_PROVIDER",
	use_api_socket: "COMPOSE_REASON_API_SOCKET",
	device_cgroup_rules: "COMPOSE_REASON_DEVICE_RULES",
	cgroup_parent: "COMPOSE_REASON_CGROUP_PARENT",
	runtime: "COMPOSE_REASON_RUNTIME",
	isolation: "COMPOSE_REASON_ISOLATION",
	oom_kill_disable: "COMPOSE_REASON_OOM_KILL",
	sysctls: "COMPOSE_REASON_SYSCTLS",
	external_links: "COMPOSE_REASON_EXTERNAL_LINKS",
	credential_spec: "COMPOSE_REASON_CREDENTIAL_SPEC",
	label_file: "COMPOSE_REASON_LABEL_FILE",
	storage_opt: "COMPOSE_REASON_STORAGE_OPT",
};

const RESERVED_LABEL_PREFIXES = ["traefik.", "com.docker."];
/** Panel labels the transform sets on services (any other is refused). */
const PANEL_SERVICE_LABELS = new Set<string>([
	DOCKER_LABELS.app,
	DOCKER_LABELS.service,
	DOCKER_LABELS.routed,
	OWNER_LABEL,
]);

/** Keys of compose `labels` (mapping, or `key=value` list). */
function labelKeysOf(labels: unknown): string[] {
	if (Array.isArray(labels)) {
		return labels.map((item) => String(item).split("=")[0]);
	}
	return isObj(labels) ? Object.keys(labels) : [];
}

export const isObj = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A compose file refused by the policy (or the transform): what it asks
 * for is blocked, as opposed to a template or input mistake. Callers that
 * render an upstream version add a "pick another version" hint.
 */
export class ComposePolicyError<
	C extends ErrorCode = ErrorCode,
> extends TemplateError<C> {
	constructor(...args: AppErrorArgs<C>) {
		super(...args);
		this.name = "ComposePolicyError";
	}
}

/** Refuse the compose model (a coded ComposePolicyError). */
function fail<C extends ErrorCode>(...args: AppErrorArgs<C>): never {
	throw new ComposePolicyError(args[0], args[1] as never);
}

/** True when a `$` would be interpolated by compose (`$$` is a literal). */
export function hasInterpolation(value: unknown): boolean {
	return (
		typeof value === "string" && /\$(?!\$)/.test(value.replace(/\$\$/g, ""))
	);
}

/** Truthiness as compose/YAML 1.1 would read it: anything but false/absent. */
export function isTruthy(value: unknown): boolean {
	if (value === undefined || value === null || value === false) return false;
	if (typeof value === "string") {
		return !/^(false|no|off|n|0|)$/i.test(value.trim());
	}
	return value !== 0;
}

function insideRoot(root: string, target: string): boolean {
	const normalized = path.posix.normalize(target);
	return normalized === root || normalized.startsWith(`${root}/`);
}

export function hostPathAllowed(
	source: string,
	allow: ComposeAllowlist,
): boolean {
	const normalized = path.posix.normalize(source);
	if (normalized === DOCKER_SOCKET) return !!allow.dockerSocket;
	return (allow.hostPaths ?? []).some(
		(allowed) => normalized === allowed || normalized.startsWith(`${allowed}/`),
	);
}

/**
 * Files Nitrobase writes at the top of an app folder: a container must not be
 * able to read or replace them (secrets, compose file), so neither they nor
 * the app folder itself may be bind-mounted.
 */
export const RESERVED_APP_ENTRIES = new Set([
	".env",
	"custom.env",
	"database-links.env",
	"service-env",
	"docker-compose.yml",
	// Owner marker and network attachments.
	hiddenFileName("instance"),
	hiddenFileName("networks"),
]);

/** Who mounts a path: a service, or a top-level volume (driver device). */
type MountOwner = { service: string } | { volume: string };

/** A bind source inside the app folder: a strict subpath, not a reserved file. */
function assertBindableInApp(
	appRoot: string,
	source: string,
	owner: MountOwner,
): void {
	const normalized = path.posix.normalize(source).replace(/\/+$/, "");
	if (normalized === appRoot) {
		if ("volume" in owner) fail("COMPOSE_VOLUME_MOUNT_APP_FOLDER", owner);
		fail("COMPOSE_MOUNT_APP_FOLDER", owner);
	}
	const first = normalized.slice(appRoot.length + 1).split("/")[0];
	if (RESERVED_APP_ENTRIES.has(first)) {
		if ("volume" in owner) {
			fail("COMPOSE_VOLUME_MOUNT_RESERVED", { ...owner, entry: first });
		}
		fail("COMPOSE_MOUNT_RESERVED", { ...owner, entry: first });
	}
}

/**
 * A host path that contains the app folder (a parent, e.g. `/etc/nitrobase`
 * or `/`) would expose its secrets: refused even if a template allowlists it.
 */
function assertNotAboveApp(
	appRoot: string,
	source: string,
	owner: MountOwner,
): void {
	const normalized = path.posix.normalize(source).replace(/\/+$/, "") || "/";
	if (normalized === "/" || appRoot.startsWith(`${normalized}/`)) {
		if ("volume" in owner) {
			fail("COMPOSE_VOLUME_MOUNT_ABOVE_APP", { ...owner, path: source });
		}
		fail("COMPOSE_MOUNT_ABOVE_APP", { ...owner, path: source });
	}
}

/** Reject YAML merge keys left in the tree (they would be re-applied by compose). */
export function assertNoMergeKeys(value: unknown, where = "compose"): void {
	if (Array.isArray(value)) {
		for (const item of value) assertNoMergeKeys(item, where);
		return;
	}
	if (!isObj(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (key === "<<") fail("COMPOSE_MERGE_KEYS", { where });
		assertNoMergeKeys(child, `${where}.${key}`);
	}
}

function scalar(
	mode: PolicyMode,
	service: string | null,
	field: string,
	value: unknown,
): void {
	if (mode === "raw" && hasInterpolation(value)) {
		if (service === null) fail("COMPOSE_TOP_FIELD_VARIABLES", { field });
		fail("COMPOSE_FIELD_VARIABLES", { service, field });
	}
}

function checkPathField(
	mode: PolicyMode,
	ctx: ComposePolicyContext,
	service: string | null,
	field: string,
	value: unknown,
): void {
	if (value === undefined) return;
	if (typeof value !== "string") {
		if (service === null) fail("COMPOSE_TOP_FIELD_NOT_PATH", { field });
		fail("COMPOSE_FIELD_NOT_PATH", { service, field });
	}
	scalar(mode, service, field, value);
	if (!value.startsWith("/") || !insideRoot(ctx.appRoot, value)) {
		if (service === null) {
			fail("COMPOSE_TOP_FILE_OUTSIDE", { field, path: value });
		}
		fail("COMPOSE_FILE_OUTSIDE", { service, field, path: value });
	}
}

function namespaceTarget(
	value: unknown,
	field: string,
	service: string,
	services: Obj,
	allowed: string[],
): void {
	if (value === undefined) return;
	if (typeof value !== "string")
		fail("COMPOSE_FIELD_INVALID", { service, field });
	if (allowed.includes(value)) return;
	if (value.startsWith("service:") && value.slice(8) in services) return;
	fail("COMPOSE_NOT_ALLOWED", { service, setting: `${field}: ${value}` });
}

function listOf(value: unknown): unknown[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function checkVolumeEntry(
	entry: unknown,
	ctx: ComposePolicyContext,
	mode: PolicyMode,
	service: string,
	declaredVolumes: Set<string>,
): void {
	const allow = ctx.allow ?? {};
	let type: unknown;
	let source: unknown;
	if (typeof entry === "string") {
		scalar(mode, service, "volumes", entry);
		const parts = entry.split(":");
		if (parts.length === 1) return; // anonymous volume
		source = parts[0];
		type = String(source).startsWith("/") ? "bind" : "volume";
	} else if (isObj(entry)) {
		type = entry.type ?? "volume";
		source = entry.source;
		scalar(mode, service, "volumes.source", source);
		scalar(mode, service, "volumes.type", type);
	} else {
		fail("COMPOSE_VOLUME_INVALID", { service });
	}

	if (type === "tmpfs") return;
	if (type === "volume") {
		if (source === undefined) return;
		if (typeof source !== "string") {
			fail("COMPOSE_VOLUME_SOURCE_INVALID", { service });
		}
		const name = mode === "resolved" ? source : source;
		if (!declaredVolumes.has(name)) {
			fail("COMPOSE_VOLUME_NOT_DECLARED", { service, volume: name });
		}
		return;
	}
	if (type !== "bind") {
		fail("COMPOSE_VOLUME_TYPE", { service, type: String(type) });
	}
	if (typeof source !== "string" || !source.startsWith("/")) {
		fail("COMPOSE_BIND_NOT_ABSOLUTE", { service, source: String(source) });
	}
	if (insideRoot(ctx.appRoot, source)) {
		assertBindableInApp(ctx.appRoot, source, { service });
		return;
	}
	assertNotAboveApp(ctx.appRoot, source, { service });
	if (!hostPathAllowed(source, allow)) {
		if (path.posix.normalize(source) === DOCKER_SOCKET) {
			fail("COMPOSE_DOCKER_SOCKET", { service });
		}
		fail("COMPOSE_HOST_PATH", { service, path: source });
	}
}

function checkBuild(
	build: unknown,
	ctx: ComposePolicyContext,
	mode: PolicyMode,
	service: string,
): void {
	if (build === undefined) return;
	if (typeof build === "string") {
		checkPathField(mode, ctx, service, "build", build);
		return;
	}
	if (!isObj(build)) fail("COMPOSE_BUILD_INVALID", { service });
	const context = build.context ?? ".";
	if (typeof context === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(context)) {
		fail("COMPOSE_REMOTE_BUILD", { service });
	}
	if (mode === "raw" && context === ".") {
		fail("COMPOSE_BUILD_CONTEXT_REQUIRED", { service });
	}
	checkPathField(mode, ctx, service, "build.context", context);
	if (build.dockerfile !== undefined) {
		const dockerfile = build.dockerfile;
		scalar(mode, service, "build.dockerfile", dockerfile);
		if (typeof dockerfile !== "string")
			fail("COMPOSE_FIELD_INVALID", { service, field: "build.dockerfile" });
		const resolved = path.posix.isAbsolute(dockerfile)
			? dockerfile
			: path.posix.join(String(context), dockerfile);
		if (!insideRoot(ctx.appRoot, resolved)) {
			fail("COMPOSE_DOCKERFILE_OUTSIDE", { service });
		}
	}
	if (
		isObj(build.additional_contexts) ||
		Array.isArray(build.additional_contexts)
	) {
		const values = Array.isArray(build.additional_contexts)
			? build.additional_contexts.map((item) =>
					String(item).split("=").slice(1).join("="),
				)
			: Object.values(build.additional_contexts);
		for (const value of values) {
			scalar(mode, service, "build.additional_contexts", value);
			const text = String(value);
			if (text.startsWith("docker-image://") || text.startsWith("service:"))
				continue;
			checkPathField(mode, ctx, service, "build.additional_contexts", text);
		}
	}
	for (const key of ["ssh", "entitlements", "privileged"] as const) {
		if (
			key === "privileged"
				? isTruthy(build.privileged)
				: build[key] !== undefined
		) {
			fail("COMPOSE_NOT_ALLOWED", { service, setting: `build.${key}` });
		}
	}
	if (build.network !== undefined) {
		scalar(mode, service, "build.network", build.network);
		if (!["default", "none"].includes(String(build.network))) {
			fail("COMPOSE_NOT_ALLOWED", {
				service,
				setting: `build.network: ${String(build.network)}`,
			});
		}
	}
}

/**
 * Validate the final shape of an app's compose model. Used on our own
 * transform output (`raw`) and on `docker compose config` output
 * (`resolved`) right before deploying. Throws TemplateError on violation.
 */
export function assertSafeCompose(
	compose: unknown,
	ctx: ComposePolicyContext,
	mode: PolicyMode,
): void {
	const allow = ctx.allow ?? {};
	const external = new Set(allow.external ?? []);
	if (!isObj(compose)) fail("COMPOSE_NOT_MAPPING");
	assertNoMergeKeys(compose);

	for (const key of Object.keys(compose)) {
		if (!TOP_LEVEL_KEYS.has(key) && !key.startsWith("x-")) {
			fail("COMPOSE_TOP_KEY_NOT_ALLOWED", { key });
		}
	}
	if (compose.name !== ctx.folder) fail("COMPOSE_NAME_CHANGED");
	const services = compose.services;
	if (!isObj(services) || Object.keys(services).length === 0) {
		fail("COMPOSE_NO_SERVICES");
	}
	assertResources(services, ctx.resources);

	// Top-level resources.
	const declaredVolumes = new Set<string>();
	const declaredNetworks = new Set<string>(["default"]);
	const checkResources = (kind: string, entries: unknown) => {
		if (entries === undefined) return;
		if (!isObj(entries)) fail("COMPOSE_TOP_LEVEL_NOT_MAPPING", { kind });
		for (const [key, raw] of Object.entries(entries)) {
			const entry: Obj = isObj(raw) ? raw : {};
			const externalName = typeof entry.name === "string" ? entry.name : key;
			scalar(mode, null, `${kind}.${key}.name`, entry.name);
			// Panel labels on a network would pass it off as the panel's (a
			// link network with our instance id is pruned by the panel).
			// Volumes are left alone: changing a volume's labels makes
			// compose recreate it (data loss).
			if (kind === "networks") {
				const label = labelKeysOf(entry.labels).find(isReservedLabel);
				if (label) {
					fail("COMPOSE_TOP_NETWORK_LABEL_RESERVED", { network: key, label });
				}
			}
			// Shared networks are joined by `docker network connect` only:
			// named in a compose file, Compose would register service names
			// there (see apps/networks.ts). Refused even when allowlisted.
			if (
				kind === "networks" &&
				(isReservedLinkNetworkKey(key) ||
					isReservedLinkNetworkName(externalName))
			) {
				fail("COMPOSE_TOP_LINK_NETWORK_RESERVED", { network: key });
			} else if (
				kind === "networks" &&
				(isReservedProxyNetworkKey(key) || externalName === ctx.network)
			) {
				fail("COMPOSE_TOP_NETWORK_RESERVED", { network: key });
			} else if (isTruthy(entry.external)) {
				if (!external.has(externalName)) {
					fail("COMPOSE_EXTERNAL_NOT_ALLOWED", { kind, name: externalName });
				}
			} else if (
				typeof entry.name === "string" &&
				!entry.name.startsWith(`${ctx.folder}_`)
			) {
				fail("COMPOSE_NOT_SCOPED", { kind, name: key });
			}
			if (entry.file !== undefined) {
				checkPathField(mode, ctx, null, `${kind}.${key}.file`, entry.file);
			}
			if (kind === "volumes") {
				declaredVolumes.add(key);
				if (mode === "resolved" && typeof entry.name === "string") {
					declaredVolumes.add(entry.name);
				}
				if (isObj(entry.driver_opts)) {
					for (const [opt, value] of Object.entries(entry.driver_opts)) {
						scalar(mode, null, `volumes.${key}.driver_opts.${opt}`, value);
					}
					const device = entry.driver_opts.device;
					if (typeof device === "string" && device.startsWith("/")) {
						if (insideRoot(ctx.appRoot, device)) {
							assertBindableInApp(ctx.appRoot, device, { volume: key });
						} else {
							assertNotAboveApp(ctx.appRoot, device, { volume: key });
						}
					}
					if (
						typeof device === "string" &&
						device.startsWith("/") &&
						!insideRoot(ctx.appRoot, device) &&
						!hostPathAllowed(device, allow)
					) {
						fail("COMPOSE_VOLUME_HOST_DEVICE", { volume: key, path: device });
					}
				}
			}
			if (kind === "networks") declaredNetworks.add(key);
		}
	};
	checkResources("volumes", compose.volumes);
	checkResources("networks", compose.networks);
	checkResources("configs", compose.configs);
	checkResources("secrets", compose.secrets);

	for (const [name, raw] of Object.entries(services)) {
		if (!isObj(raw)) fail("COMPOSE_SERVICE_NOT_MAPPING", { service: name });
		const svc = raw;

		for (const [key, reason] of Object.entries(DENIED_SERVICE_KEYS)) {
			if (svc[key] !== undefined) {
				fail("COMPOSE_KEY_DENIED", {
					service: name,
					setting: key,
					reason: { $error: { code: reason, params: {}, text: null } },
				});
			}
		}
		if (isObj(svc.extends) && svc.extends.file !== undefined) {
			fail("COMPOSE_EXTENDS_FILE", { service: name });
		}

		// Mounts first: a Docker socket bind is the refusal that explains the
		// rest (upstreams add `privileged` / `security_opt` to use it).
		for (const entry of listOf(svc.volumes)) {
			checkVolumeEntry(entry, ctx, mode, name, declaredVolumes);
		}

		scalar(mode, name, "privileged", svc.privileged);
		if (isTruthy(svc.privileged) && !allow.privileged) {
			fail("COMPOSE_NOT_ALLOWED", { service: name, setting: "privileged" });
		}
		for (const hook of [...listOf(svc.post_start), ...listOf(svc.pre_stop)]) {
			if (isObj(hook) && isTruthy(hook.privileged)) {
				fail("COMPOSE_PRIVILEGED_HOOK", { service: name });
			}
		}

		for (const field of [
			"pid",
			"ipc",
			"uts",
			"userns_mode",
			"cgroup",
		] as const) {
			scalar(mode, name, field, svc[field]);
		}
		namespaceTarget(
			svc.pid,
			"pid",
			name,
			services,
			allow.hostPid ? ["host"] : [],
		);
		namespaceTarget(svc.ipc, "ipc", name, services, [
			"private",
			"shareable",
			"none",
		]);
		namespaceTarget(svc.uts, "uts", name, services, []);
		namespaceTarget(svc.userns_mode, "userns_mode", name, services, []);
		namespaceTarget(svc.cgroup, "cgroup", name, services, ["private"]);

		scalar(mode, name, "network_mode", svc.network_mode);
		if (svc.network_mode !== undefined) {
			namespaceTarget(
				svc.network_mode,
				"network_mode",
				name,
				services,
				allow.hostNetwork ? ["none", "host"] : ["none"],
			);
			if (ctx.proxiedServices.includes(name)) {
				fail("COMPOSE_ROUTED_NETWORK_MODE", { service: name });
			}
		}

		const listAllowed = (field: string, allowed: string[] | undefined) => {
			for (const item of listOf(svc[field])) {
				scalar(mode, name, field, item);
				const text = isObj(item) ? JSON.stringify(item) : String(item);
				if (!(allowed ?? []).includes(text)) {
					fail("COMPOSE_NOT_ALLOWED", {
						service: name,
						setting: `${field}: ${text}`,
					});
				}
			}
		};
		listAllowed("cap_add", allow.capAdd);
		listAllowed("devices", allow.devices);
		listAllowed("security_opt", allow.securityOpt);

		scalar(mode, name, "container_name", svc.container_name);
		if (svc.container_name !== `${ctx.folder}-${name}`) {
			fail("COMPOSE_CONTAINER_NAME", { service: name });
		}

		const labels = isObj(svc.labels) ? svc.labels : {};
		for (const key of Object.keys(labels)) {
			scalar(mode, name, "labels", key);
			if (RESERVED_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix))) {
				fail("COMPOSE_LABEL_RESERVED", { service: name, label: key });
			}
			// Panel labels: only the ones the transform writes.
			if (isReservedLabel(key) && !PANEL_SERVICE_LABELS.has(key)) {
				fail("COMPOSE_LABEL_RESERVED", { service: name, label: key });
			}
		}
		if (labels[DOCKER_LABELS.app] !== ctx.appId) {
			fail("COMPOSE_APP_LABEL_MISSING", { service: name });
		}
		if (ctx.instanceId && labels[OWNER_LABEL] !== ctx.instanceId) {
			fail("COMPOSE_INSTANCE_LABEL_MISSING", { service: name });
		}
		// Monitoring attaches containers with this label to the proxy network.
		const routed = ctx.proxiedServices.includes(name) ? "true" : undefined;
		if (labels[DOCKER_LABELS.routed] !== routed) {
			fail("COMPOSE_LABEL_RESERVED", {
				service: name,
				label: DOCKER_LABELS.routed,
			});
		}

		checkPorts(svc.ports, ctx, name);
		for (const ref of listOf(svc.volumes_from)) {
			scalar(mode, name, "volumes_from", ref);
			const target = String(ref).split(":")[0];
			if (String(ref).startsWith("container:") || !(target in services)) {
				fail("COMPOSE_VOLUMES_FROM", { service: name, ref: String(ref) });
			}
		}
		for (const file of listOf(svc.env_file)) {
			checkPathField(
				mode,
				ctx,
				name,
				"env_file",
				isObj(file) ? file.path : file,
			);
		}
		checkBuild(svc.build, ctx, mode, name);

		if (svc.network_mode === undefined) {
			const networks = isObj(svc.networks)
				? Object.keys(svc.networks)
				: listOf(svc.networks).map(String);
			for (const network of networks) {
				scalar(mode, name, "networks", network);
				if (isReservedProxyNetworkKey(network)) {
					fail("COMPOSE_NETWORK_RESERVED", { service: name, network });
				}
				if (isReservedLinkNetworkKey(network)) {
					fail("COMPOSE_LINK_NETWORK_RESERVED", { service: name, network });
				}
				if (!declaredNetworks.has(network)) {
					fail("COMPOSE_NETWORK_NOT_DECLARED", { service: name, network });
				}
			}
		}
	}
}
