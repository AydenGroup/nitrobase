import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DOCKER_LABELS, RESOURCE_PREFIX } from "#/config/identifiers.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import type { ErrorCode } from "#/libs/error-codes.ts";
import { type AppErrorArgs, coded } from "#/utils/error.ts";
import type { NetworkAttachment } from "../apps/networks";
import { OWNER_LABEL } from "../ownership";
import {
	assertNoMergeKeys,
	assertSafeCompose,
	type ComposeAllowlist,
	ComposePolicyError,
	DOCKER_SOCKET,
	hostPathAllowed,
	isObj,
	isReservedLinkNetworkKey,
	isReservedProxyNetworkKey,
	isTruthy,
	joinsLinkNetwork,
	type LinkNetwork,
	type PublishedPort,
	publishedPortSpec,
} from "./compose-policy";
import { TemplateError } from "./naming";
import {
	applyResources,
	effectiveLimits,
	type ServiceResources,
} from "./resources";
import {
	applyDefaultRestart,
	applyStopSafeRestart,
	type DefaultRestart,
} from "./restart";

export interface ComposeTransformContext {
	appId: string;
	/** Folder / compose project name, e.g. `pocketbase-1a2b3c4d`. */
	folder: string;
	/** Absolute app directory on the host, e.g. `/etc/nitrobase/apps/<folder>`. */
	appRoot: string;
	/** Shared proxy network name (external). */
	network: string;
	/** Services that Traefik routes to: only these join the shared network. */
	proxiedServices: string[];
	allow?: ComposeAllowlist;
	/** Owner-enabled host ports (template `[[ports]]`); all others are removed. */
	publishedPorts?: PublishedPort[];
	/**
	 * This panel's instance id: containers are labelled with it so other
	 * panels on the same server never treat them as theirs.
	 */
	instanceId?: string;
	/** Resource limits per service (template defaults + app overrides). */
	resources?: Record<string, ServiceResources>;
	/** Limits for services left without any (server policy). */
	fallbackResources?: ServiceResources;
	/** Database link networks (joined by the listed services after `up`). */
	linkNetworks?: LinkNetwork[];
	/**
	 * Restart policy for services that declare none (`APP_DEFAULT_RESTART`),
	 * minus the template's `no_default_restart` services. Unset: none added.
	 */
	defaultRestart?: DefaultRestart;
}

export interface ComposeTransformResult {
	compose: Record<string, unknown>;
	yaml: string;
	/** Final container name per service. */
	containerNames: Record<string, string>;
	/**
	 * Shared networks the containers join after `up` with `docker network
	 * connect` (proxy network for routed services, database link networks):
	 * never named in the compose file (see `apps/networks.ts`).
	 */
	networkAttachments: NetworkAttachment[];
	/** Coded warnings (rendered with `errorText`). */
	warnings: ErrorInfo[];
	/** Services given `ctx.defaultRestart` (they declared no policy). */
	restartDefaulted: string[];
	/** Services whose `restart: always` became the default (BUG-030). */
	restartStopSafe: string[];
}

type Obj = Record<string, unknown>;

const PANEL_LABEL_PREFIX = `${RESOURCE_PREFIX}.`;
/** Label prefixes stripped from services: Traefik, Docker, the panel's. */
const RESERVED_LABEL_PREFIXES = ["traefik.", "com.docker.", PANEL_LABEL_PREFIX];

/**
 * Whether `key` falls under `prefix`. The panel's prefix matches
 * case-insensitively (`Nitrobase.x` too), like the policy's
 * `isReservedLabel`; Traefik and Docker ones as Docker reads them.
 */
const underPrefix = (key: string, prefix: string) =>
	prefix === PANEL_LABEL_PREFIX
		? key.toLowerCase().startsWith(prefix)
		: key.startsWith(prefix);

/** Refuse the compose file (a coded ComposePolicyError). */
function fail<C extends ErrorCode>(...args: AppErrorArgs<C>): never {
	throw new ComposePolicyError(args[0], args[1] as never);
}

/**
 * Resolve a relative bind source to an absolute path inside the app root.
 * Rejects `..` escapes.
 */
function insideAppRoot(
	appRoot: string,
	source: string,
	service: string | null,
): string {
	const resolved = path.posix.normalize(path.posix.join(appRoot, source));
	if (resolved !== appRoot && !resolved.startsWith(`${appRoot}/`)) {
		fail("COMPOSE_PATH_ESCAPES", { service: service ?? "", path: source });
	}
	return resolved;
}

/**
 * Refuse a Docker socket bind unless allowed: the socket itself, or a
 * host path given by a variable mounted at the socket's path (upstream's
 * `${DOCKER_SOCKET_LOCATION}:/var/run/docker.sock`). Short or long syntax.
 */
function assertNoDockerSocket(
	volumes: unknown,
	allow: ComposeAllowlist,
	service: string,
): void {
	if (!Array.isArray(volumes) || allow.dockerSocket) return;
	const isSocket = (value: unknown) =>
		typeof value === "string" &&
		value.startsWith("/") &&
		path.posix.normalize(value) === DOCKER_SOCKET;
	for (const entry of volumes) {
		let source: unknown;
		let target: unknown;
		if (typeof entry === "string") {
			[source, target] = entry.split(":");
		} else if (isObj(entry) && entry.type === "bind") {
			source = entry.source;
			target = entry.target;
		}
		if (typeof source !== "string") continue;
		if (isSocket(source) || (source.includes("${") && isSocket(target))) {
			fail("COMPOSE_DOCKER_SOCKET", { service });
		}
	}
}

/** Classify and rewrite one volume source. Returns the new source. */
function rewriteVolumeSource(
	source: string,
	ctx: ComposeTransformContext,
	service: string,
	warnings: ErrorInfo[],
	namedVolumes: Set<string>,
): string {
	const allow = ctx.allow ?? {};
	if (source.includes("${")) {
		fail("COMPOSE_VOLUME_VARIABLES", { service, source });
	}
	if (source.startsWith(".") || source.startsWith("~")) {
		if (source.startsWith("~")) {
			fail("COMPOSE_HOME_PATH", { service, path: source });
		}
		return insideAppRoot(ctx.appRoot, source, service);
	}
	if (source.startsWith("/")) {
		const normalized = path.posix.normalize(source);
		if (
			normalized === ctx.appRoot ||
			normalized.startsWith(`${ctx.appRoot}/`)
		) {
			return normalized;
		}
		if (!hostPathAllowed(normalized, allow)) {
			if (normalized === DOCKER_SOCKET) {
				fail("COMPOSE_DOCKER_SOCKET", { service });
			}
			fail("COMPOSE_HOST_PATH", { service, path: source });
		}
		warnings.push(
			coded("COMPOSE_WARN_HOST_PATH", { service, path: normalized }),
		);
		return normalized;
	}
	// Named volume: compose scopes it to the project.
	namedVolumes.add(source);
	return source;
}

function transformVolumes(
	volumes: unknown,
	ctx: ComposeTransformContext,
	service: string,
	warnings: ErrorInfo[],
	namedVolumes: Set<string>,
): unknown[] {
	if (!Array.isArray(volumes)) {
		fail("COMPOSE_NOT_LIST", { service, field: "volumes" });
	}
	return volumes.map((entry) => {
		if (typeof entry === "string") {
			const parts = entry.split(":");
			if (parts.length === 1) return entry; // anonymous volume
			const [source, ...rest] = parts;
			const rewritten = rewriteVolumeSource(
				source,
				ctx,
				service,
				warnings,
				namedVolumes,
			);
			return [rewritten, ...rest].join(":");
		}
		if (isObj(entry)) {
			const type = entry.type ?? "volume";
			if (type === "bind" && typeof entry.source === "string") {
				return {
					...entry,
					source: rewriteVolumeSource(
						entry.source,
						ctx,
						service,
						warnings,
						namedVolumes,
					),
				};
			}
			if (type === "volume" && typeof entry.source === "string") {
				namedVolumes.add(entry.source);
				return entry;
			}
			if (
				type === "tmpfs" ||
				(type === "volume" && entry.source === undefined)
			) {
				return entry;
			}
			return fail("COMPOSE_VOLUME_TYPE", { service, type: String(type) });
		}
		return fail("COMPOSE_VOLUME_INVALID", { service });
	});
}

function normalizeLabels(labels: unknown): Obj {
	if (labels === undefined) return {};
	if (Array.isArray(labels)) {
		return Object.fromEntries(
			labels.map((label) => {
				const text = String(label);
				const index = text.indexOf("=");
				return index === -1
					? [text, ""]
					: [text.slice(0, index), text.slice(index + 1)];
			}),
		);
	}
	if (isObj(labels)) return { ...labels };
	return {};
}

function normalizeNetworks(
	networks: unknown,
	service: string,
): Record<string, Obj> {
	if (networks === undefined) return {};
	if (Array.isArray(networks)) {
		return Object.fromEntries(networks.map((name) => [String(name), {}]));
	}
	if (isObj(networks)) {
		return Object.fromEntries(
			Object.entries(networks).map(([name, value]) => [
				name,
				isObj(value) ? { ...value } : {},
			]),
		);
	}
	fail("COMPOSE_NETWORKS_INVALID", { service });
}

function checkRelativeFile(
	value: unknown,
	ctx: ComposeTransformContext,
	service: string,
	field: string,
): unknown {
	if (typeof value !== "string") return value;
	if (value.startsWith("/")) {
		const normalized = path.posix.normalize(value);
		if (
			normalized === ctx.appRoot ||
			normalized.startsWith(`${ctx.appRoot}/`)
		) {
			return normalized;
		}
		fail("COMPOSE_FILE_OUTSIDE", { service, field, path: value });
	}
	return insideAppRoot(ctx.appRoot, value, service);
}

/**
 * Make an untrusted compose file safe and unique per app:
 * - project `name` = folder; `container_name` = `<folder>-<service>`, the
 *   original name kept as a network alias on the app's own networks;
 * - host `ports` removed (Traefik routes traffic); `expose` kept;
 * - no service names a shared network (proxy, database links): Compose
 *   would register the service name there too, so `kong` of one app
 *   would resolve to another app's `kong`. Routed services are labelled
 *   `nitrobase.routed` and every shared network is listed in
 *   `networkAttachments`, joined after `up` by container name only
 *   (`apps/networks.ts`); service names stay on the app's own networks;
 * - labels `nitrobase.app` / `nitrobase.service` added;
 * - `ctx.defaultRestart` given to services without a restart policy
 *   (one-shot jobs other services wait on excepted);
 * - relative bind mounts, env files and build contexts pinned inside the app
 *   folder; host paths, Docker socket, privileged, host network/pid/ipc,
 *   cap_add, devices, security_opt and external resources rejected unless
 *   allowlisted (allowed items are reported as warnings);
 * - explicit names of volumes/networks/configs/secrets prefixed with the folder.
 */
export function transformCompose(
	source: string | Obj,
	ctx: ComposeTransformContext,
): ComposeTransformResult {
	const allow = ctx.allow ?? {};
	const external = new Set(allow.external ?? []);
	const warnings: ErrorInfo[] = [];
	// Apply YAML merge keys like compose does, and cap aliases (billion laughs).
	const parsed =
		typeof source === "string"
			? parseYaml(source, { merge: true, maxAliasCount: 100 })
			: structuredClone(source);
	assertNoMergeKeys(parsed);
	if (!isObj(parsed)) throw new TemplateError("COMPOSE_NOT_MAPPING");
	if (!isObj(parsed.services) || Object.keys(parsed.services).length === 0) {
		throw new TemplateError("COMPOSE_NO_SERVICES");
	}
	for (const key of Object.keys(parsed)) {
		if (key === "include") fail("COMPOSE_INCLUDE");
	}

	const compose: Obj = { ...parsed, name: ctx.folder };
	const services = parsed.services as Record<string, unknown>;
	const containerNames: Record<string, string> = {};
	const originalNames: Record<string, string> = {};
	const namedVolumes = new Set<string>();
	const networkAttachments: NetworkAttachment[] = [];

	for (const [name, value] of Object.entries(services)) {
		if (!isObj(value)) fail("COMPOSE_SERVICE_NOT_MAPPING", { service: name });
		containerNames[name] = `${ctx.folder}-${name}`;
		if (typeof value.container_name === "string") {
			originalNames[value.container_name] = name;
		}
	}
	for (const name of ctx.proxiedServices) {
		if (!(name in services)) fail("COMPOSE_ROUTED_MISSING", { service: name });
	}

	const outServices: Obj = {};
	for (const [name, raw] of Object.entries(services) as [string, Obj][]) {
		const svc: Obj = { ...raw };

		// A Docker socket bind is reported before the settings upstreams add
		// alongside it (`privileged`, `security_opt: label=disable`).
		assertNoDockerSocket(svc.volumes, allow, name);

		// Privilege escalation surface.
		if (isTruthy(svc.privileged)) {
			if (!allow.privileged) {
				fail("COMPOSE_NOT_ALLOWED", { service: name, setting: "privileged" });
			}
			warnings.push(coded("COMPOSE_WARN_PRIVILEGED", { service: name }));
		}
		for (const field of [
			"pid",
			"ipc",
			"uts",
			"userns_mode",
			"cgroup",
		] as const) {
			const value = svc[field];
			if (value === "host") {
				if (!(field === "pid" && allow.hostPid)) {
					fail("COMPOSE_NOT_ALLOWED", {
						service: name,
						setting: `${field}: host`,
					});
				}
				warnings.push(
					coded("COMPOSE_WARN_HOST_NAMESPACE", { service: name, field }),
				);
			} else if (typeof value === "string" && value.startsWith("container:")) {
				// Only namespaces of services in this app.
				const target = originalNames[value.slice("container:".length)];
				if (
					!target ||
					field === "uts" ||
					field === "userns_mode" ||
					field === "cgroup"
				) {
					fail("COMPOSE_NOT_ALLOWED", {
						service: name,
						setting: `${field}: ${value}`,
					});
				}
				svc[field] = `service:${target}`;
			}
		}
		const listCheck = (field: string, allowed: string[] | undefined) => {
			if (svc[field] === undefined) return;
			if (!Array.isArray(svc[field])) {
				fail("COMPOSE_NOT_LIST", { service: name, field });
			}
			for (const item of svc[field] as unknown[]) {
				if (!(allowed ?? []).includes(String(item))) {
					fail("COMPOSE_NOT_ALLOWED", {
						service: name,
						setting: `${field}: ${String(item)}`,
					});
				}
			}
			warnings.push(
				coded("COMPOSE_WARN_ALLOWED_LIST", {
					service: name,
					field,
					values: { $list: (svc[field] as unknown[]).map(String) },
				}),
			);
		};
		listCheck("cap_add", allow.capAdd);
		listCheck("devices", allow.devices);
		listCheck("security_opt", allow.securityOpt);
		if (svc.external_links !== undefined)
			fail("COMPOSE_NOT_ALLOWED", { service: name, setting: "external_links" });
		if (isObj(svc.extends) && svc.extends.file !== undefined) {
			fail("COMPOSE_EXTENDS_FILE", { service: name });
		}
		if (svc.volumes_from !== undefined) {
			for (const ref of svc.volumes_from as unknown[]) {
				if (String(ref).startsWith("container:"))
					fail("COMPOSE_NOT_ALLOWED", {
						service: name,
						setting: "volumes_from: container:",
					});
			}
		}

		// Unique container name; keep the original as an alias.
		const aliases: string[] = [];
		if (typeof svc.container_name === "string" && svc.container_name !== name) {
			aliases.push(svc.container_name);
		}
		svc.container_name = containerNames[name];

		if (svc.ports !== undefined) {
			warnings.push(coded("COMPOSE_WARN_PORTS_REMOVED", { service: name }));
			delete svc.ports;
		}
		const published = (ctx.publishedPorts ?? []).filter(
			(port) => port.service === name,
		);
		if (published.length) svc.ports = published.map(publishedPortSpec);

		// Networking.
		const networkMode = svc.network_mode;
		if (typeof networkMode === "string") {
			if (networkMode === "host") {
				if (!allow.hostNetwork) {
					fail("COMPOSE_NOT_ALLOWED", {
						service: name,
						setting: "network_mode: host",
					});
				}
				warnings.push(coded("COMPOSE_WARN_HOST_NETWORK", { service: name }));
			} else if (networkMode.startsWith("container:")) {
				const target = originalNames[networkMode.slice("container:".length)];
				if (!target)
					fail("COMPOSE_NETWORK_MODE_REF", {
						service: name,
						mode: networkMode,
					});
				svc.network_mode = `service:${target}`;
			} else if (networkMode.startsWith("service:")) {
				if (!(networkMode.slice(8) in services))
					fail("COMPOSE_UNKNOWN_REF", { service: name, ref: networkMode });
			} else if (networkMode !== "none") {
				fail("COMPOSE_NOT_ALLOWED", {
					service: name,
					setting: `network_mode: ${networkMode}`,
				});
			}
			if (ctx.proxiedServices.includes(name)) {
				fail("COMPOSE_ROUTED_NETWORK_MODE", { service: name });
			}
		} else {
			const networks = normalizeNetworks(svc.networks, name);
			if (Object.keys(networks).length === 0) networks.default = {};
			const proxyKey = Object.keys(networks).find(isReservedProxyNetworkKey);
			if (proxyKey)
				fail("COMPOSE_NETWORK_RESERVED", {
					service: name,
					network: proxyKey,
				});
			if (aliases.length) {
				for (const network of Object.values(networks)) {
					const existing = Array.isArray(network.aliases)
						? network.aliases
						: [];
					network.aliases = [...new Set([...existing, ...aliases])];
				}
			}
			for (const key of Object.keys(networks)) {
				if (isReservedLinkNetworkKey(key))
					fail("COMPOSE_LINK_NETWORK_RESERVED", {
						service: name,
						network: key,
					});
			}
			// Shared networks: attached after `up`, never declared here.
			const container = containerNames[name];
			if (ctx.proxiedServices.includes(name)) {
				networkAttachments.push({ container, network: ctx.network });
			}
			for (const link of ctx.linkNetworks ?? []) {
				if (joinsLinkNetwork(link, name)) {
					networkAttachments.push({ container, network: link.name });
				}
			}
			svc.networks = networks;
		}

		// Labels.
		const labels = normalizeLabels(svc.labels);
		const removedLabels: string[] = [];
		for (const key of Object.keys(labels)) {
			if (RESERVED_LABEL_PREFIXES.some((prefix) => underPrefix(key, prefix))) {
				removedLabels.push(key);
				delete labels[key];
			}
		}
		if (removedLabels.length === 1) {
			warnings.push(
				coded("COMPOSE_WARN_LABEL_REMOVED", {
					service: name,
					label: removedLabels[0],
				}),
			);
		} else if (removedLabels.length > 1) {
			// One line per service (upstream Traefik labels come in dozens).
			const prefixes = RESERVED_LABEL_PREFIXES.filter((prefix) =>
				removedLabels.some((key) => underPrefix(key, prefix)),
			).map((prefix) => `${prefix}*`);
			warnings.push(
				coded("COMPOSE_WARN_LABELS_REMOVED", {
					service: name,
					count: removedLabels.length,
					prefixes: { $list: prefixes },
				}),
			);
		}
		svc.labels = {
			...labels,
			[DOCKER_LABELS.app]: ctx.appId,
			[DOCKER_LABELS.service]: name,
			...(ctx.instanceId ? { [OWNER_LABEL]: ctx.instanceId } : {}),
			...(ctx.proxiedServices.includes(name)
				? { [DOCKER_LABELS.routed]: "true" }
				: {}),
		};
		applyResources(svc, ctx.resources?.[name]);
		if (ctx.fallbackResources && !effectiveLimits(svc).memoryMb) {
			applyResources(svc, ctx.fallbackResources);
		}

		// Files and mounts.
		if (svc.volumes !== undefined) {
			svc.volumes = transformVolumes(
				svc.volumes,
				ctx,
				name,
				warnings,
				namedVolumes,
			);
		}
		if (svc.env_file !== undefined) {
			const files = Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
			svc.env_file = files.map((file) =>
				isObj(file)
					? {
							...file,
							path: checkRelativeFile(file.path, ctx, name, "env_file"),
						}
					: checkRelativeFile(file, ctx, name, "env_file"),
			);
		}
		if (typeof svc.build === "string") {
			svc.build = checkRelativeFile(svc.build, ctx, name, "build");
		} else if (isObj(svc.build)) {
			const build = { ...svc.build };
			build.context ??= ".";
			if (
				typeof build.context === "string" &&
				/^[a-z]+:\/\//.test(build.context)
			) {
				fail("COMPOSE_REMOTE_BUILD", { service: name });
			}
			build.context = checkRelativeFile(
				build.context,
				ctx,
				name,
				"build.context",
			);
			if (
				typeof build.dockerfile === "string" &&
				build.dockerfile.startsWith("/")
			) {
				fail("COMPOSE_DOCKERFILE_ABSOLUTE", { service: name });
			}
			if (build.privileged === true)
				fail("COMPOSE_PRIVILEGED_BUILD", { service: name });
			svc.build = build;
		}

		outServices[name] = svc;
	}
	const restartDefaulted = applyDefaultRestart(
		outServices as Record<string, Obj>,
		ctx.defaultRestart,
	);
	const restartStopSafe = applyStopSafeRestart(
		outServices as Record<string, Obj>,
		ctx.defaultRestart,
	);
	compose.services = outServices;

	// Top-level resources.
	const prefixNamed = (kind: string, entries: unknown, allowFile: boolean) => {
		if (entries === undefined) return undefined;
		if (!isObj(entries)) fail("COMPOSE_TOP_LEVEL_NOT_MAPPING", { kind });
		const out: Obj = {};
		for (const [key, raw] of Object.entries(entries)) {
			const entry: Obj = isObj(raw) ? { ...raw } : {};
			if (entry.external) {
				const externalName = typeof entry.name === "string" ? entry.name : key;
				if (!external.has(externalName)) {
					fail("COMPOSE_EXTERNAL_NOT_ALLOWED", { kind, name: externalName });
				}
				warnings.push(
					coded("COMPOSE_WARN_EXTERNAL", { kind, name: externalName }),
				);
			} else if (typeof entry.name === "string") {
				entry.name = `${ctx.folder}_${entry.name}`;
			}
			// Ownership label: lets Nitrobase recognise its volumes later
			// (orphan cleanup) without trusting name patterns.
			if (kind === "volumes" && !entry.external) {
				entry.labels = {
					...normalizeLabels(entry.labels),
					[DOCKER_LABELS.app]: ctx.appId,
				};
			}
			if (allowFile && typeof entry.file === "string") {
				entry.file = checkRelativeFile(entry.file, ctx, kind, "file");
			}
			if (kind === "volumes" && isObj(entry.driver_opts)) {
				const device = entry.driver_opts.device;
				if (typeof device === "string" && device.startsWith("/")) {
					if (
						!hostPathAllowed(device, ctx.allow ?? {}) &&
						!(device === ctx.appRoot || device.startsWith(`${ctx.appRoot}/`))
					) {
						fail("COMPOSE_VOLUME_HOST_DEVICE", { volume: key, path: device });
					}
				}
			}
			out[key] = Object.keys(entry).length ? entry : {};
		}
		return out;
	};
	const volumes = prefixNamed("volumes", parsed.volumes, false);
	for (const name of namedVolumes) {
		if (!volumes || !(name in volumes)) {
			fail("COMPOSE_VOLUME_UNDECLARED", { volume: name });
		}
	}
	if (volumes) compose.volumes = volumes;
	const networks = prefixNamed("networks", parsed.networks, false) ?? {};
	const proxyKey = Object.keys(networks).find(isReservedProxyNetworkKey);
	if (proxyKey) fail("COMPOSE_TOP_NETWORK_RESERVED", { network: proxyKey });
	for (const key of Object.keys(networks)) {
		if (isReservedLinkNetworkKey(key)) {
			fail("COMPOSE_TOP_LINK_NETWORK_RESERVED", { network: key });
		}
	}
	if (Object.keys(networks).length) compose.networks = networks;
	const configs = prefixNamed("configs", parsed.configs, true);
	if (configs) compose.configs = configs;
	const secrets = prefixNamed("secrets", parsed.secrets, true);
	if (secrets) compose.secrets = secrets;

	// Final gate: the same policy runs again on `docker compose config` output.
	assertSafeCompose(compose, ctx, "raw");

	return {
		compose,
		yaml: stringifyYaml(compose, { lineWidth: 0 }),
		containerNames,
		networkAttachments,
		warnings,
		restartDefaulted,
		restartStopSafe,
	};
}
