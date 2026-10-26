import { createHash } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { hiddenFileName } from "#/config/identifiers.ts";
import type { RestartPolicy } from "#/config/restart-policies.ts";
import type {
	TemplateManifest,
	TemplateSource,
} from "#/features/templates/schema.ts";
import {
	type CustomComposeSpec,
	customManifest,
	templateDomainHost,
	validateVariableValue,
} from "#/features/templates/schema.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { coded } from "#/utils/error.ts";
import {
	APP_NETWORKS_FILE,
	type NetworkAttachment,
	renderNetworksFile,
} from "../apps/networks";
import {
	declaredDataPaths,
	type FileBinds,
	fileBindSources,
} from "./bind-sources";
import {
	assertSafeCompose,
	type ComposePolicyContext,
	ComposePolicyError,
	joinsLinkNetwork,
	type LinkNetwork,
} from "./compose-policy";
import { transformCompose } from "./compose-transform";
import type { FetchedFile } from "./github";
import {
	appFolderName,
	assertHostname,
	ENV_NAME_PATTERN,
	RESERVED_ENV_PATTERN,
	TemplateError,
	templateError,
} from "./naming";
import { composeWithOverlay } from "./overlay";
import { mergeResources, type ServiceResources } from "./resources";
import {
	type PasswordHasher,
	withPathRoutes,
	withRouteAuth,
} from "./route-auth";
import {
	generateTraefikDynamic,
	type RouteInput,
	traefikAppFileName,
	traefikAppKey,
} from "./traefik-dynamic";
import {
	parseEnvFile,
	type RandomSource,
	renderEnvFile,
	resolveVariables,
	type VariableDefinition,
} from "./variables";
import { compareVersionNames, versionNumber } from "./versions";

/**
 * Pure template rendering: files in (fetched upstream or the template's
 * own), everything an app deploy writes out. No network, no database, no
 * config reads: the caller passes the environment. The shipped-template
 * test harness renders every template through this offline.
 */

/** User-added env vars, injected into every service (written 0600). */
export const CUSTOM_ENV_FILE = "custom.env";
/** Per-service secret env files (template `service_env`), written 0600. */
export const SERVICE_ENV_DIR = "service-env";

export function serviceEnvFile(service: string): string {
	return `${SERVICE_ENV_DIR}/${service}.env`;
}

/** Env of the app's database links (connection URLs), written 0600. */
export const LINKS_ENV_FILE = "database-links.env";

/**
 * Hidden files the deploy writes at the top of an app folder (owner marker,
 * network attachments): a template file there would overwrite or shadow
 * them.
 */
export const RESERVED_TEMPLATE_FILES: readonly string[] = [
	hiddenFileName("instance"),
	hiddenFileName("networks"),
];

/** True when a template file would land on a reserved hidden file. */
export const isReservedTemplateFile = (file: string) =>
	RESERVED_TEMPLATE_FILES.includes(file.replace(/^(\.\/)+/, ""));

/** True when a rendered file holds secrets (written 0600). */
export function isSecretFile(file: string): boolean {
	return (
		file === CUSTOM_ENV_FILE ||
		file === LINKS_ENV_FILE ||
		file.startsWith(`${SERVICE_ENV_DIR}/`)
	);
}

export interface RenderSettings {
	/** Apps root on the server, e.g. `/etc/nitrobase/apps`. */
	appsRoot: string;
	/** Traefik dynamic config directory on the server. */
	traefikDynamicDir: string;
	/** Shared proxy network. */
	network: string;
	certResolver: string;
	/** Hashes basic-auth passwords for Traefik. */
	hasher: PasswordHasher;
	/** This panel's instance id (container owner label). */
	instanceId?: string;
	/**
	 * Restart policy for services that declare none (`APP_DEFAULT_RESTART`);
	 * unset: compose files keep what they declare.
	 */
	defaultRestart?: RestartPolicy;
}

export interface RenderInput {
	manifest: TemplateManifest;
	/** Template files incl. the compose file (`manifest.source.compose`). */
	files: FetchedFile[];
	/** The template's compose overlay (YAML), if any. */
	overlay: string | null;
	/**
	 * The template's version-gated overlays (`[[overlays]]`), in order:
	 * merged after `overlay` when the version is at least `minVersion`.
	 */
	versionOverlays?: { minVersion: string; content: string }[];
	/** Warnings from fetching (skipped files...). */
	fetchWarnings?: ErrorInfo[];
	version: string;
	commitSha: string;
	appId: string;
	appName?: string;
	domain: string;
	overrides?: Record<string, string>;
	existing?: Record<string, string>;
	/** Env editor: any variable may be overridden and custom ones added. */
	allowCustomOverrides?: boolean;
	/** Routes from the app's domains (default: derived from template domains). */
	routes?: RouteInput[];
	/** Owner-enabled published ports: template port id -> host port. */
	publishedPorts?: Record<string, number>;
	/** Port ids bound on 127.0.0.1 only. */
	loopbackPorts?: string[];
	/** Values of the template's `service_env` files, by service. */
	serviceEnv?: Record<string, Record<string, string>>;
	/** The app's resource limit overrides (`null` = no Nitrobase limit). */
	resources?: Record<string, ServiceResources>;
	/** Limits for services left without a memory limit (server policy). */
	fallbackResources?: ServiceResources;
	/**
	 * Database links (R3 M2): networks this app joins (both sides of a
	 * link) and, for a linked app, the env its services get (connection
	 * URLs; a separate 0600 env file, after custom.env).
	 */
	linkNetworks?: LinkNetwork[];
	linkEnv?: Record<string, string>;
	/**
	 * Literal defaults that come before template variables (custom compose:
	 * the owner's env). Upstream `env_defaults` are read from `files`.
	 */
	extraDefaults?: Record<string, string>;
	/** Deterministic generation (tests). */
	random?: RandomSource;
	now?: number;
}

export interface RenderedTemplate {
	templateId: string;
	version: string;
	commitSha: string;
	appId: string;
	folder: string;
	appRoot: string;
	domain: string;
	compose: string;
	/** Resolved values (contains secrets: never send to the client as is). */
	values: Record<string, string>;
	envFile: string;
	traefik: { path: string; yaml: string } | null;
	files: FetchedFile[];
	warnings: ErrorInfo[];
	/** Parsed transformed compose (for policy checks). */
	composeModel: Record<string, unknown>;
	containerNames: Record<string, string>;
	/** Shared networks joined after `up` (`APP_NETWORKS_FILE`). */
	networkAttachments: NetworkAttachment[];
	services: string[];
	routes: RouteInput[];
	/** Variable name -> expression (template + upstream defaults). */
	definitions: Record<string, string>;
	secretKeys: string[];
	credentialKeys: string[];
	policy: ComposePolicyContext;
	/** Docker networks of database links (must exist before `up`). */
	linkNetworks: string[];
	/**
	 * Bind sources in the app folder expected to be files on the server
	 * (checked before and after `up`, see `bind-sources.ts`).
	 */
	fileBinds: FileBinds;
}

/** Version label of custom-compose apps (no upstream versions). */
export const INLINE_VERSION = "custom";

/** Version/commit of a custom compose: a digest of the compose and env. */
export function inlineCommit(
	spec: Pick<CustomComposeSpec, "compose" | "env">,
): string {
	return createHash("sha1")
		.update(spec.compose)
		.update("\0")
		.update(spec.env)
		.digest("hex");
}

/** Render input of a custom-compose app (`source.type = "inline"`). */
export function inlineRenderInput(
	manifest: TemplateManifest,
	spec: CustomComposeSpec,
): Pick<
	RenderInput,
	"manifest" | "files" | "overlay" | "extraDefaults" | "version" | "commitSha"
> {
	return {
		manifest: customManifest(manifest, spec),
		files: [
			{
				path: manifest.source.compose,
				content: Buffer.from(spec.compose),
				executable: false,
			},
		],
		overlay: null,
		extraDefaults: parseEnvFile(spec.env),
		version: INLINE_VERSION,
		commitSha: inlineCommit(spec),
	};
}

/**
 * Run `render` on an upstream version's files: a compose policy refusal
 * becomes TEMPLATE_VERSION_BLOCKED (the setting comes with that version,
 * so the owner picks another one; nothing in the form would change it).
 * Other errors pass as they are.
 */
export function withUpstreamRefusals<T>(version: string, render: () => T): T {
	try {
		return render();
	} catch (error) {
		if (!(error instanceof ComposePolicyError)) throw error;
		throw new TemplateError("TEMPLATE_VERSION_BLOCKED", {
			version,
			reason: { $error: coded(error.code, error.params as never) },
		});
	}
}

/** True without a minimum, or when `version` is at least `min`. */
export function versionAtLeast(version: string, min?: string): boolean {
	return !min || compareVersionNames(version, min) >= 0;
}

/**
 * `source.include` paths fetched at `version`: version-gated entries
 * (`{ path, min_version }`) only from their `min_version` on.
 */
export function includedPaths(
	include: TemplateSource["include"],
	version: string,
): string[] {
	return include.flatMap((item) =>
		typeof item === "string"
			? [item]
			: versionAtLeast(version, item.min_version)
				? [item.path]
				: [],
	);
}

/**
 * Characters a rewrite may insert into a file (URL characters): never a
 * quote, backslash, backtick, `$` or whitespace, so a value cannot escape
 * the string literal it lands in (e.g. an import specifier).
 */
const REWRITE_VALUE = /^[A-Za-z0-9._~:/?#@!&*+,;=%-]*$/;

/**
 * Template `[[rewrites]]`: opt-in literal substitutions in the copied
 * files, applied only when the `when` variable is set. File entries are
 * replaced, never mutated (fetched files are cached).
 */
export function applyRewrites(
	files: FetchedFile[],
	rewrites: TemplateManifest["rewrites"],
	values: Record<string, string>,
	warnings: ErrorInfo[],
): void {
	// Alternatives (e.g. both quote styles) share a file and variable: a
	// warning only when none of them matched.
	const matched = new Map<string, boolean>();
	for (const rewrite of rewrites) {
		if (!values[rewrite.when]) continue;
		const group = `${rewrite.path}\0${rewrite.when}`;
		if (!matched.has(group)) matched.set(group, false);
		const replacement = rewrite.replace.replace(
			/\$\{([^}]*)\}/g,
			(_, raw: string) => {
				const name = raw.trim();
				const value = values[name] ?? "";
				if (!REWRITE_VALUE.test(value)) {
					throw new TemplateError("TEMPLATE_REWRITE_VALUE_INVALID", { name });
				}
				return value;
			},
		);
		const index = files.findIndex((file) => file.path === rewrite.path);
		const text = index === -1 ? null : files[index].content.toString("utf8");
		if (text === null || !text.includes(rewrite.find)) continue;
		matched.set(group, true);
		files[index] = {
			...files[index],
			content: Buffer.from(text.split(rewrite.find).join(replacement)),
		};
	}
	for (const [group, hit] of matched) {
		if (hit) continue;
		const [file, name] = group.split("\0");
		warnings.push(coded("TEMPLATE_WARN_REWRITE_UNMATCHED", { file, name }));
	}
}

/** Compose `$` escaping for literal defaults (`$` -> `$$`). */
const literal = (value: string) => value.replace(/\$/g, "$$$$");

export function renderFromFiles(
	input: RenderInput,
	settings: RenderSettings,
): RenderedTemplate {
	const { manifest } = input;
	const source = manifest.source;
	const warnings = [...(input.fetchWarnings ?? [])];
	const files = [...input.files];
	if (files.some((file) => isSecretFile(file.path))) {
		throw new TemplateError("TEMPLATE_RESERVED_FILES", {
			files: { $list: [CUSTOM_ENV_FILE, `${SERVICE_ENV_DIR}/`] },
		});
	}
	if (files.some((file) => isReservedTemplateFile(file.path))) {
		throw new TemplateError("TEMPLATE_RESERVED_FILES", {
			files: { $list: [...RESERVED_TEMPLATE_FILES] },
		});
	}
	const byPath = new Map(files.map((file) => [file.path, file]));
	const composeFile = byPath.get(source.compose);
	if (!composeFile) {
		throw new TemplateError("TEMPLATE_FILE_MISSING", { file: source.compose });
	}

	const appId = input.appId;
	const folder = appFolderName(manifest.id, appId);
	const appRoot = `${settings.appsRoot}/${folder}`;
	const domain = assertHostname(input.domain);
	const version = input.version;

	// Upstream defaults first (literal values), template variables override.
	const definitions: Record<string, VariableDefinition> = {};
	const addDefaults = (
		entries: Record<string, string>,
		origin: "upstream" | "variable",
	) => {
		for (const [name, value] of Object.entries(entries)) {
			// e.g. upstream COMPOSE_FILE: Nitrobase controls compose itself.
			if (RESERVED_ENV_PATTERN.test(name)) {
				warnings.push(
					origin === "upstream"
						? coded("TEMPLATE_WARN_UPSTREAM_RESERVED", { name })
						: coded("TEMPLATE_WARN_VARIABLE_RESERVED", { name }),
				);
				continue;
			}
			definitions[name] = { value: literal(value) };
		}
	};
	if (source.env_defaults) {
		const defaults = byPath.get(source.env_defaults);
		if (!defaults) {
			throw new TemplateError("TEMPLATE_FILE_MISSING", {
				file: source.env_defaults,
			});
		}
		addDefaults(parseEnvFile(defaults.content.toString("utf8")), "upstream");
	}
	if (input.extraDefaults) addDefaults(input.extraDefaults, "variable");
	for (const [name, variable] of Object.entries(manifest.variables)) {
		if (!versionAtLeast(version, variable.min_version)) continue;
		definitions[name] = { value: variable.value };
	}
	for (const [name, value] of Object.entries(input.overrides ?? {})) {
		const variable = manifest.variables[name];
		if (!variable) {
			if (input.allowCustomOverrides && !(name in definitions)) continue;
			if (!input.allowCustomOverrides) {
				throw new TemplateError("VARIABLE_UNKNOWN", { name });
			}
		} else if (!variable.editable && !input.allowCustomOverrides) {
			throw new TemplateError("VARIABLE_NOT_EDITABLE", { name });
		}
		if (variable) {
			const error = validateVariableValue(name, variable, value);
			if (error) throw templateError(error);
		}
	}

	const values = resolveVariables(definitions, {
		builtins: {
			domain,
			url: `https://${domain}`,
			version,
			version_number: versionNumber(version, source.version_prefix),
			app_id: appId,
			app_name: input.appName ?? manifest.name,
			folder,
		},
		overrides: input.overrides,
		existing: input.existing,
		random: input.random,
		now: input.now,
	});

	applyRewrites(files, manifest.rewrites, values, warnings);

	// Env editor: user-added variables are passed through as is and, since
	// the template's compose doesn't reference them, also injected into
	// every service through a separate env file.
	const custom: Record<string, string> = {};
	if (input.allowCustomOverrides) {
		for (const [name, value] of Object.entries(input.overrides ?? {})) {
			if (!(name in definitions)) {
				if (!ENV_NAME_PATTERN.test(name)) {
					throw new TemplateError("VARIABLE_NAME_INVALID", { name });
				}
				values[name] = value;
				custom[name] = value;
			}
		}
	}

	const routes: RouteInput[] = withRouteAuth(
		withPathRoutes(
			input.routes ??
				manifest.domains.map((route) => ({
					host: templateDomainHost(route, domain),
					service: route.service,
					port: route.port,
					https: route.https,
					pathPrefix: route.path_prefix,
				})),
			manifest,
		),
		manifest,
		values,
		settings.hasher,
	);
	const proxied = [
		...new Set([
			...manifest.domains.map((d) => d.service),
			...routes.map((route) => route.service),
		]),
	];
	const security = manifest.security;
	const templateResources = Object.fromEntries(
		Object.entries(manifest.resources).map(([service, limits]) => [
			service,
			{
				memoryMb: limits.memory_mb ?? null,
				memoryReservationMb: limits.memory_reservation_mb ?? null,
				cpus: limits.cpus ?? null,
			},
		]),
	);
	const policy: ComposePolicyContext = {
		appId,
		folder,
		appRoot,
		network: settings.network,
		proxiedServices: proxied,
		instanceId: settings.instanceId,
		resources: mergeResources(
			[
				...new Set([
					...Object.keys(templateResources),
					...Object.keys(input.resources ?? {}),
				]),
			],
			templateResources,
			input.resources,
		),
		fallbackResources: input.fallbackResources,
		allow: {
			privileged: security.privileged,
			hostNetwork: security.host_network,
			hostPid: security.host_pid,
			dockerSocket: security.docker_socket,
			capAdd: security.cap_add,
			devices: security.devices,
			securityOpt: security.security_opt,
			hostPaths: security.host_paths,
			external: security.external,
		},
		linkNetworks: input.linkNetworks?.length ? input.linkNetworks : undefined,
		publishedPorts: Object.entries(input.publishedPorts ?? {}).map(
			([id, published]) => {
				const port = manifest.ports.find((item) => item.id === id);
				if (!port)
					throw new TemplateError("TEMPLATE_PORT_UNKNOWN", { port: id });
				return {
					service: port.service,
					target: port.port,
					published,
					loopback: input.loopbackPorts?.includes(id) ?? false,
				};
			},
		),
	};
	const transformed = transformCompose(
		composeWithOverlay(composeFile.content.toString("utf8"), [
			input.overlay,
			...(input.versionOverlays ?? [])
				.filter((item) => versionAtLeast(version, item.minVersion))
				.map((item) => item.content),
		]),
		{
			...policy,
			defaultRestart: settings.defaultRestart
				? {
						policy: settings.defaultRestart,
						keep: manifest.no_default_restart,
					}
				: undefined,
		},
	);
	warnings.push(...transformed.warnings);
	let composeYaml = transformed.yaml;
	// Extra env files per service: custom.env for all, service-env/<svc>.env
	// for the template's `service_env` services.
	const extraEnvFiles = new Map<string, string[]>();
	const services = transformed.compose.services as Record<
		string,
		Record<string, unknown>
	>;
	if (Object.keys(custom).length > 0) {
		for (const [serviceName, service] of Object.entries(services)) {
			// `environment:` wins over env_file: such a custom value is ignored.
			const environment = service.environment;
			const declared = Array.isArray(environment)
				? environment.map((item) => String(item).split("=")[0])
				: Object.keys((environment as Record<string, unknown>) ?? {});
			for (const name of Object.keys(custom)) {
				if (declared.includes(name)) {
					warnings.push(
						coded("TEMPLATE_WARN_CUSTOM_IGNORED", {
							service: serviceName,
							name,
						}),
					);
				}
			}
			extraEnvFiles.set(serviceName, [`${appRoot}/${CUSTOM_ENV_FILE}`]);
		}
		files.push({
			path: CUSTOM_ENV_FILE,
			content: Buffer.from(renderEnvFile(custom)),
			executable: false,
		});
	}
	const linkEnv = input.linkEnv ?? {};
	if (Object.keys(linkEnv).length > 0) {
		for (const [serviceName, service] of Object.entries(services)) {
			// Services sharing another's network stack can't join the link.
			if (service.network_mode !== undefined) continue;
			if (
				!(input.linkNetworks ?? []).some((link) =>
					joinsLinkNetwork(link, serviceName),
				)
			) {
				continue;
			}
			const environment = service.environment;
			const declared = Array.isArray(environment)
				? environment.map((item) => String(item).split("=")[0])
				: Object.keys((environment as Record<string, unknown>) ?? {});
			for (const name of Object.keys(linkEnv)) {
				if (declared.includes(name)) {
					warnings.push(
						coded("TEMPLATE_WARN_LINKED_IGNORED", {
							service: serviceName,
							name,
						}),
					);
				}
			}
			extraEnvFiles.set(serviceName, [
				...(extraEnvFiles.get(serviceName) ?? []),
				`${appRoot}/${LINKS_ENV_FILE}`,
			]);
		}
		files.push({
			path: LINKS_ENV_FILE,
			content: Buffer.from(renderEnvFile(linkEnv)),
			executable: false,
		});
	}
	for (const serviceName of manifest.service_env) {
		if (!(serviceName in services)) {
			warnings.push(
				coded("TEMPLATE_WARN_SERVICE_ENV_MISSING", { service: serviceName }),
			);
			continue;
		}
		const file = serviceEnvFile(serviceName);
		extraEnvFiles.set(serviceName, [
			...(extraEnvFiles.get(serviceName) ?? []),
			`${appRoot}/${file}`,
		]);
		files.push({
			path: file,
			content: Buffer.from(
				renderEnvFile(input.serviceEnv?.[serviceName] ?? {}),
			),
			executable: false,
		});
	}
	if (extraEnvFiles.size > 0) {
		for (const [serviceName, envFiles] of extraEnvFiles) {
			const service = services[serviceName];
			const existing =
				service.env_file === undefined ? [] : [service.env_file].flat();
			service.env_file = [...existing, ...envFiles];
		}
		assertSafeCompose(transformed.compose, policy, "raw");
		composeYaml = stringifyYaml(transformed.compose, { lineWidth: 0 });
	}
	const appKey = traefikAppKey(appId);
	const traefik = routes.length
		? {
				// Flat in the dynamic dir: Traefik does not watch subdirectories.
				path: `${settings.traefikDynamicDir}/${traefikAppFileName(appKey)}`,
				yaml: generateTraefikDynamic({
					appKey,
					routes,
					containerNames: transformed.containerNames,
					certResolver: settings.certResolver,
				}),
			}
		: null;

	// Shared networks the containers join after `up` (apps/networks.ts);
	// written even when empty, so an emptied list is not left stale.
	const written = files.filter(
		(file) =>
			file.path !== APP_NETWORKS_FILE &&
			file.path !== source.compose &&
			file.path !== manifest.overlay &&
			!manifest.overlays.some((item) => item.path === file.path) &&
			file.path !== source.env_defaults &&
			file.path !== ".env",
	);
	written.push({
		path: APP_NETWORKS_FILE,
		content: Buffer.from(renderNetworksFile(transformed.networkAttachments)),
		executable: false,
	});
	return {
		templateId: manifest.id,
		version,
		commitSha: input.commitSha,
		appId,
		folder,
		appRoot,
		domain,
		compose: composeYaml,
		values,
		envFile: renderEnvFile(values),
		traefik,
		// The overlay is merged in, the compose file is written separately.
		files: written,
		warnings,
		composeModel: transformed.compose,
		containerNames: transformed.containerNames,
		networkAttachments: transformed.networkAttachments,
		services: Object.keys(transformed.containerNames),
		routes,
		definitions: Object.fromEntries(
			Object.entries(definitions).map(([name, def]) => [name, def.value]),
		),
		secretKeys: Object.entries(manifest.variables)
			.filter(([, variable]) => variable.secret)
			.map(([name]) => name),
		credentialKeys: Object.entries(manifest.variables)
			.filter(([, variable]) => variable.credential)
			.map(([name]) => name),
		policy,
		linkNetworks: (input.linkNetworks ?? []).map((link) => link.name),
		fileBinds: fileBindSources({
			composeModel: transformed.compose,
			appRoot,
			files: written,
			dataPaths: declaredDataPaths(manifest),
		}),
	};
}
