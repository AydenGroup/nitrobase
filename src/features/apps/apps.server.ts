import { createHash, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { and, desc, eq, like, or } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { appSourceKindOf } from "#/config/app-sources.ts";
import { DATABASE_TEMPLATE_ID } from "#/config/database-engines.ts";
import {
	databaseRowRequirements,
	type Permission,
} from "#/config/permissions.ts";
import { defaultRestartOf } from "#/config/restart-policies.ts";
import { appBaseUrl, getConfig, hostPaths } from "#/config/server.ts";
import { isUniqueViolation } from "#/db/errors.ts";
import { db } from "#/db/index.ts";
import {
	type AppInputFields,
	type AppInputs,
	apps,
	domains,
	type StoredAppInputs,
} from "#/db/schema/apps.ts";
import { deployments, servers } from "#/db/schema/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess } from "#/features/auth/access.ts";
import {
	isAppBusy,
	recoverOrphanedJobs,
	withAppServerLock,
} from "#/features/deployments/deployments.server.ts";
import { latestContainerSamples } from "#/features/monitoring/monitoring.server.ts";
import type { DeploymentDTO, ServerRow } from "#/features/servers/schema.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { tunnelServiceUrl } from "#/features/servers/tunnel.server.ts";
import { getSetting } from "#/features/settings/settings.server.ts";
import {
	allowedSecurity,
	type CustomComposeSpec,
	CustomComposeSpecSchema,
	extraDomainRules,
	type TemplateManifest,
	templateDomainHost,
	validateVariableValue,
} from "#/features/templates/schema.ts";
import {
	dryRenderNewApp,
	getTemplateManifest,
	getTemplateVersions,
	serviceEnvFile,
} from "#/features/templates/templates.server.ts";
import {
	type AppLocation,
	assertAppLocation,
} from "#/server/services/apps/commands.ts";
import {
	applyEnvChanges,
	applyEnvReset,
	frozenInitialValues,
	isGeneratedExpression,
	keepFrozenValues,
	maskedEnvText,
	SECRET_MASK,
} from "#/server/services/apps/env-state.ts";
import { declaresSharedNetworks } from "#/server/services/apps/networks.ts";
import {
	allServicesHealthy,
	serviceRunState,
} from "#/server/services/apps/readiness.ts";
import { audit } from "#/server/services/audit.ts";
import { getFreeDomainProvider } from "#/server/services/domains/free-domains.ts";
import {
	appFolderName,
	assertHostname,
	hostLabelFromName,
	templateError,
} from "#/server/services/templates/naming.ts";
import { mergeResources } from "#/server/services/templates/resources.ts";
import {
	oneShotServicesOf,
	optionalServicesOf,
	restartPolicyPending,
} from "#/server/services/templates/restart.ts";
import {
	traefikAppFileName,
	traefikAppKey,
} from "#/server/services/templates/traefik-dynamic.ts";
import { decrypt, encrypt } from "#/utils/crypto.ts";
import { AppError } from "#/utils/error.ts";
import type {
	AppCredential,
	AppDTO,
	AppEnvEdit,
	AppEnvVariable,
	AppEnvView,
	AppOverview,
	AppRow,
	CreateAppInput,
	DomainRow,
	ServiceEnvView,
} from "./schema";
import { rotateHookView } from "./schema";
import { secretEnvKeys } from "./secret-env";
import { type SourceApp, sourceDriver } from "./sources.server";

const appColumns = {
	id: apps.id,
	teamId: apps.teamId,
	userId: apps.userId,
	serverId: apps.serverId,
	name: apps.name,
	templateId: apps.templateId,
	version: apps.version,
	commitSha: apps.commitSha,
	folder: apps.folder,
	status: apps.status,
	needsRedeploy: apps.needsRedeploy,
	envPendingAt: apps.envPendingAt,
	routesPending: apps.routesPending,
	lastError: apps.lastError,
	lastErrorCode: apps.lastErrorCode,
	lastErrorParams: apps.lastErrorParams,
	createdAt: apps.createdAt,
	updatedAt: apps.updatedAt,
} as const;

/**
 * App row of the actor's team (secrets included; server-only). The server
 * function gate checked the action's permission; `permission` re-checks it
 * here for callers that do more than read.
 */
export async function getAppRow(
	actor: Actor,
	appId: string,
	permission: Permission = "app.view",
): Promise<AppRow> {
	const [row] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	if (row?.templateId === DATABASE_TEMPLATE_ID) {
		// A database: app permissions stand for database ones, for this
		// check and for the request's gate (an `app.deploy` token must not
		// redeploy or delete a database without `database.manage`).
		const [first, ...extra] = databaseRowRequirements(permission);
		assertCanAccess(actor, row, first, "APP_NOT_FOUND");
		for (const required of [
			...extra,
			...(actor.gate ? databaseRowRequirements(actor.gate) : []),
		]) {
			assertCanAccess(actor, required);
		}
		return row;
	}
	return assertCanAccess(actor, row, permission, "APP_NOT_FOUND");
}

export async function getAppServer(app: AppRow): Promise<ServerRow> {
	const [server] = await db
		.select()
		.from(servers)
		.where(eq(servers.id, app.serverId))
		.limit(1);
	if (!server) throw new AppError("SERVER_NOT_FOUND");
	return server;
}

/** Validated location: the folder is a slug directly under the apps root. */
export function appLocation(app: Pick<AppRow, "folder" | "id">): AppLocation {
	const root = hostPaths().apps;
	return assertAppLocation(
		{ folder: app.folder, appRoot: `${root}/${app.folder}`, appId: app.id },
		root,
	);
}

export function appTraefikPath(appId: string): string {
	return `${hostPaths().traefikDynamic}/${traefikAppFileName(traefikAppKey(appId))}`;
}

export function readEnvValues(
	app: Pick<AppRow, "envEncrypted">,
): Record<string, string> {
	if (!app.envEncrypted) return {};
	return JSON.parse(decrypt(app.envEncrypted)) as Record<string, string>;
}

export function encryptEnvValues(values: Record<string, string>): string {
	return encrypt(JSON.stringify(values));
}

type EnvState = Pick<
	AppRow,
	"envEncrypted" | "envPendingAt" | "envDeployedEncrypted"
>;

/**
 * The env the app actually runs with: the stored one, or while a deploy's
 * values are pending (written, never live) the one live before that
 * (empty: never deployed). Diffs against "what runs" use this; renders
 * carry generated values over from the stored (pending) env.
 */
export function deployedEnvValues(app: EnvState): Record<string, string> {
	if (!app.envPendingAt) return readEnvValues(app);
	return readEnvValues({ envEncrypted: app.envDeployedEncrypted });
}

/**
 * Columns storing `values` before a deploy writes them to the server: they
 * are pending until it succeeds. The live env is kept aside on the first
 * pending write (a later one keeps that snapshot).
 */
export function pendingEnvColumns(
	app: EnvState & Pick<AppRow, "composeDeployed">,
	values: Record<string, string>,
): Pick<AppRow, "envEncrypted" | "envPendingAt" | "envDeployedEncrypted"> {
	return {
		envEncrypted: encryptEnvValues(values),
		envPendingAt: new Date(),
		envDeployedEncrypted: app.envPendingAt
			? app.envDeployedEncrypted
			: app.composeDeployed
				? app.envEncrypted
				: null,
	};
}

/** A successful deploy: the stored env is the live one. */
export const deployedEnvColumns = {
	envPendingAt: null,
	envDeployedEncrypted: null,
} as const;

export type ServiceEnvValues = Record<string, Record<string, string>>;

/** Decrypted `service_env` values by service (server-only: secrets). */
export function readServiceEnv(
	app: Pick<AppRow, "serviceEnvEncrypted">,
): ServiceEnvValues {
	if (!app.serviceEnvEncrypted) return {};
	return JSON.parse(decrypt(app.serviceEnvEncrypted)) as ServiceEnvValues;
}

export function encryptServiceEnv(values: ServiceEnvValues): string {
	return encrypt(JSON.stringify(values));
}

/** The owner's compose/env/choices of a custom-compose app (server-only: env). */
export function readCustomSpec(
	app: Pick<AppRow, "customSpecEncrypted">,
): CustomComposeSpec | null {
	if (!app.customSpecEncrypted) return null;
	return CustomComposeSpecSchema.parse(
		JSON.parse(decrypt(app.customSpecEncrypted)),
	);
}

export function encryptCustomSpec(spec: CustomComposeSpec): string {
	return encrypt(JSON.stringify(spec));
}

/**
 * The manifest that applies to an app: its template's, adjusted by its
 * source driver (a custom compose's or git app's own routes, health and
 * backup volumes).
 */
export async function getAppManifest(
	app: SourceApp,
): Promise<TemplateManifest> {
	const manifest = await getTemplateManifest(app.templateId);
	return (await sourceDriver(manifest)).manifest(manifest, app);
}

/** An app's inputs besides its overrides: nothing to decrypt. */
export function appInputs(app: Pick<AppRow, "inputs">): AppInputFields {
	const {
		overridesEncrypted: _encrypted,
		overrides: _legacy,
		...fields
	} = app.inputs ?? ({} as StoredAppInputs);
	return fields;
}

/**
 * An app's overrides (deploy form and env editor values), decrypted. Rows
 * written before they were encrypted keep them in plain `overrides`.
 */
export function appOverrides(
	app: Pick<AppRow, "inputs">,
): Record<string, string> {
	const encrypted = app.inputs?.overridesEncrypted;
	if (encrypted) return JSON.parse(decrypt(encrypted));
	return { ...(app.inputs?.overrides as Record<string, string> | undefined) };
}

/**
 * The app's stored `inputs` with `patch` applied (what `apps.inputs` is set
 * to). Given overrides are stored encrypted, never in plain text; without
 * any, the stored ones are kept as they are (not decrypted).
 */
export function patchAppInputs(
	app: Pick<AppRow, "inputs">,
	patch: Partial<AppInputFields> & { overrides?: Record<string, string> },
): StoredAppInputs {
	const { overrides, ...fields } = patch;
	const next: StoredAppInputs = { ...app.inputs, ...fields };
	if (overrides) {
		delete next.overrides;
		delete next.overridesEncrypted;
		if (Object.keys(overrides).length) {
			next.overridesEncrypted = encrypt(JSON.stringify(overrides));
		}
	}
	return next;
}

/** Services of the deployed compose file (container names are derived). */
export function deployedServices(
	app: Pick<AppRow, "composeDeployed">,
): string[] {
	if (!app.composeDeployed) return [];
	const model = parseYaml(app.composeDeployed) as {
		services?: Record<string, unknown>;
	};
	return Object.keys(model?.services ?? {});
}

export function containerName(folder: string, service: string): string {
	return `${folder}-${service}`;
}

export async function listAppDomains(appId: string): Promise<DomainRow[]> {
	return db
		.select()
		.from(domains)
		.where(eq(domains.appId, appId))
		.orderBy(desc(domains.primary), domains.createdAt);
}

/**
 * Public IPs to point domains at: the host itself when it is an IP, its
 * DNS records otherwise, and the host's own addresses for the local server.
 */
export async function resolveServerIps(server: ServerRow): Promise<string[]> {
	if (!server.isDefault) {
		if (isIP(server.host)) return [server.host];
		const [v4, v6] = await Promise.all([
			dns.resolve4(server.host).catch(() => [] as string[]),
			dns.resolve6(server.host).catch(() => [] as string[]),
		]);
		return [...v4, ...v6];
	}
	const executor = await getExecutor(server);
	try {
		const result = await executor.exec(
			`ip -o route get ${getConfig().PUBLIC_IP_PROBE_HOST} 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}'; hostname -I 2>/dev/null`,
		);
		return [
			...new Set(result.stdout.split(/\s+/).filter((ip) => isIP(ip) === 4)),
		];
	} finally {
		executor.close();
	}
}

/** Instance defaults the deploy forms show. */
export function deployDefaults(): { freeDomainProvider: string } {
	return { freeDomainProvider: getConfig().FREE_DOMAIN_PROVIDER };
}

/** Hosts apps may never claim: the panel's own URL and panel domain. */
export async function reservedHosts(): Promise<Set<string>> {
	const hosts = new Set<string>();
	const appUrl = appBaseUrl();
	if (appUrl) hosts.add(new URL(appUrl).hostname.toLowerCase());
	const panel = await getSetting("instance.panelDomain");
	if (panel) hosts.add(panel);
	return hosts;
}

/** A generated host (and its `<sub>.<host>` secondaries) is not in use yet. */
async function isFreeHostUnused(
	host: string,
	routes: number,
): Promise<boolean> {
	if ((await reservedHosts()).has(host)) return false;
	const taken = await db
		.select({ host: domains.host })
		.from(domains)
		.where(
			routes > 1
				? or(eq(domains.host, host), like(domains.host, `%.${host}`))
				: eq(domains.host, host),
		)
		.limit(1);
	return taken.length === 0;
}

export async function assertHostAvailable(host: string): Promise<void> {
	if ((await reservedHosts()).has(host)) {
		throw new AppError("DOMAIN_RESERVED", { host });
	}
}

// ---------------------------------------------------------------------------
// Queries

export async function listApps(actor: Actor): Promise<AppDTO[]> {
	return db
		.select(appColumns)
		.from(apps)
		.where(eq(apps.teamId, actor.teamId))
		.orderBy(desc(apps.createdAt));
}

export async function getAppOverview(
	actor: Actor,
	appId: string,
): Promise<AppOverview> {
	const app = await getAppRow(actor, appId);
	const server = await getAppServer(app);
	const appDomains = await listAppDomains(app.id);
	const manifest = await getAppManifest(app).catch(() => null);
	const primary = appDomains.find((domain) => domain.primary);
	const {
		envEncrypted: _env,
		envDeployedEncrypted: _deployedEnv,
		serviceEnvEncrypted: _serviceEnv,
		customSpecEncrypted: _customSpec,
		// The deployed compose can hold secrets (a custom compose's own
		// `environment:` values): never sent to the client.
		composeDeployed: _compose,
		inputs: _inputs,
		...dto
	} = app;
	const published = appInputs(app).publishedPorts ?? {};
	return {
		app: dto,
		networkFixPending: declaresSharedNetworks(app.composeDeployed),
		jobRunning: isAppBusy(app.serverId, app.id),
		restartPolicyPending: restartPolicyPending(
			app.composeDeployed,
			defaultRestartOf(getConfig().APP_DEFAULT_RESTART),
			manifest?.no_default_restart,
		),
		rotateHooksFailed: (appInputs(app).rotateHookFailed ?? []).flatMap(
			(name) => {
				const hook = rotateHookView(manifest?.variables[name]?.on_rotate);
				return hook ? [{ name, label: hook.label }] : [];
			},
		),
		ports: (manifest?.ports ?? []).map((port) => ({
			id: port.id,
			service: port.service,
			port: port.port,
			label: port.label,
			description: port.description,
			defaultHostPort: port.default_host_port ?? null,
			hostPort: published[port.id] ?? null,
			loopback: appInputs(app).loopbackPorts?.includes(port.id) ?? false,
		})),
		server: {
			id: server.id,
			name: server.name,
			host: server.host,
			tunnelEnabled: server.tunnelEnabled,
			tunnelOnly: server.tunnelOnly,
			tunnelService: tunnelServiceUrl(),
			ips: await resolveServerIps(server).catch(() => [] as string[]),
		},
		domains: appDomains,
		extraDomainRules: extraDomainRules(manifest?.domains ?? []),
		services: deployedServices(app),
		credentials: await listCredentials(app),
		// Templates without `credential = true` variables never have any.
		hasCredentials: Object.values(manifest?.variables ?? {}).some(
			(variable) => variable.credential,
		),
		templateName: manifest?.name ?? app.templateId,
		notes: manifest?.notes ?? null,
		limitation: manifest?.limitation ?? null,
		customCompose: manifest?.source.type === "inline",
		sourceKind: appSourceKindOf(manifest?.source.type ?? "github"),
		primaryUrl: primary
			? `${primary.https ? "https" : "http"}://${primary.host}`
			: null,
		links: appLinks(manifest?.links ?? [], appDomains),
		resources: effectiveAppResources(app, manifest, server),
		usage: await appUsage(app),
	};
}

/** Template quick links resolved to this app's domains. */
function appLinks(
	links: TemplateManifest["links"],
	appDomains: DomainRow[],
): AppOverview["links"] {
	const primary = appDomains.find((domain) => domain.primary);
	const urlFor = (service: string | undefined, path: string) => {
		const domain =
			(service && appDomains.find((item) => item.service === service)) ||
			primary;
		return domain
			? `${domain.https ? "https" : "http"}://${domain.host}${path}`
			: null;
	};
	const resolved = links
		.map((link) => ({
			label: link.label,
			url: urlFor(link.service, link.path),
			primary: link.primary,
		}))
		.filter((link): link is AppOverview["links"][number] => !!link.url);
	if (!resolved.some((link) => link.primary)) {
		const open = urlFor(undefined, "/");
		// "Open app" (UI text) is the default primary link.
		if (open) resolved.unshift({ label: "", url: open, primary: true });
	}
	return resolved;
}

/** Limits per deployed service: template defaults + the app's overrides. */
export function effectiveAppResources(
	app: AppRow,
	manifest: TemplateManifest | null,
	/** Strict server: services without a limit get its default (as on deploy). */
	server?: Pick<ServerRow, "requireLimits" | "defaultMemoryMb">,
): AppOverview["resources"] {
	const fallback =
		server?.requireLimits && server.defaultMemoryMb
			? server.defaultMemoryMb
			: null;
	const services = deployedServices(app);
	const defaults = Object.fromEntries(
		Object.entries(manifest?.resources ?? {}).map(([service, limits]) => [
			service,
			{
				memoryMb: limits.memory_mb ?? null,
				memoryReservationMb: limits.memory_reservation_mb ?? null,
				cpus: limits.cpus ?? null,
			},
		]),
	);
	const overrides = appInputs(app).resources ?? {};
	const merged = mergeResources(
		services.length ? services : Object.keys(defaults),
		defaults,
		overrides,
	);
	return (services.length ? services : Object.keys(defaults)).map(
		(service) => ({
			service,
			memoryMb: merged[service]?.memoryMb ?? fallback,
			memoryReservationMb: merged[service]?.memoryReservationMb ?? null,
			cpus: merged[service]?.cpus ?? null,
			templateMemoryMb: defaults[service]?.memoryMb ?? null,
			templateCpus: defaults[service]?.cpus ?? null,
			overridden: service in overrides,
		}),
	);
}

/** Newest CPU/RAM samples of the app's containers (monitoring). */
async function appUsage(app: AppRow): Promise<AppOverview["usage"]> {
	const since = new Date(Date.now() - getConfig().APP_USAGE_MAX_AGE_MS);
	const samples = (await latestContainerSamples(app.serverId, since)).filter(
		(sample) => sample.appId === app.id,
	);
	if (samples.length === 0) return null;
	return {
		at: new Date(Math.max(...samples.map((sample) => sample.ts))),
		cpuPercent: samples.reduce((sum, item) => sum + (item.cpuPercent ?? 0), 0),
		memUsed: samples.reduce((sum, item) => sum + (item.memUsed ?? 0), 0),
		allHealthy: allServicesHealthy(deployedServices(app), samples),
		...serviceRunState(deployedServices(app), samples, {
			oneShot: oneShotServicesOf(app.composeDeployed),
			optional: optionalServicesOf(app.composeDeployed),
			stopped: new Set(appInputs(app).stoppedServices ?? []),
		}),
		services: samples.map((sample) => ({
			service: sample.service ?? sample.container,
			cpuPercent: sample.cpuPercent,
			memUsed: sample.memUsed,
			memLimit: sample.memLimit,
		})),
	};
}

export async function listAppDeployments(
	actor: Actor,
	appId: string,
): Promise<DeploymentDTO[]> {
	await recoverOrphanedJobs();
	await getAppRow(actor, appId);
	return db
		.select({
			id: deployments.id,
			teamId: deployments.teamId,
			userId: deployments.userId,
			serverId: deployments.serverId,
			appId: deployments.appId,
			status: deployments.status,
			type: deployments.type,
			title: deployments.title,
			titleKey: deployments.titleKey,
			titleParams: deployments.titleParams,
			errorMessage: deployments.errorMessage,
			errorCode: deployments.errorCode,
			errorParams: deployments.errorParams,
			warningCount: deployments.warningCount,
			commitSha: deployments.commitSha,
			createdAt: deployments.createdAt,
			updatedAt: deployments.updatedAt,
		})
		.from(deployments)
		.where(
			and(eq(deployments.appId, appId), eq(deployments.teamId, actor.teamId)),
		)
		.orderBy(desc(deployments.createdAt))
		.limit(50);
}

// ---------------------------------------------------------------------------
// Create

/**
 * Create the app row and its domains. The primary domain is the user's, or
 * a free wildcard-DNS domain for the server's IP. Template secondary routes
 * get `<service>.<primary>`.
 */
export async function createAppRecord(
	actor: Actor,
	input: CreateAppInput,
	extra: {
		resources?: AppInputs["resources"];
		/**
		 * Render the new app before storing it (templates rendered from
		 * upstream versions): a version or input the first deploy would
		 * refuse is refused here, leaving no failed app behind.
		 */
		dryRender?: boolean;
	} = {},
): Promise<AppRow> {
	const [server] = await db
		.select()
		.from(servers)
		.where(eq(servers.id, input.serverId))
		.limit(1);
	assertCanAccess(actor, server, "app.deploy", "SERVER_NOT_FOUND");
	if (server.status !== "ready") throw new AppError("SERVER_NOT_READY");

	const template = await getTemplateManifest(input.templateId);
	// Templates that allow more than the default policy, and advanced ones,
	// need the owner's explicit acknowledgement (shown by the wizard).
	if (
		(allowedSecurity(template.security).length > 0 || template.advanced) &&
		!input.acknowledged
	) {
		throw new AppError("TEMPLATE_ACK_REQUIRED");
	}
	// The source driver validates its part of the request (compose,
	// repository, database engine) and shapes the new app.
	const { prepareCreate } = await import("./sources.server");
	const prepared = await prepareCreate({ actor, template, input });
	const manifest = prepared.manifest;
	for (const [name, value] of Object.entries(input.inputs)) {
		const variable = manifest.variables[name];
		if (!variable?.editable) {
			throw new AppError("VARIABLE_NOT_EDITABLE", { name });
		}
		if (value === "") continue;
		const error = validateVariableValue(name, variable, value);
		if (error) throw templateError(error);
	}
	assertVariablePermissions(
		actor,
		manifest.variables,
		Object.keys(input.inputs).filter((name) => input.inputs[name] !== ""),
	);
	const overrides =
		prepared.overrides ??
		Object.fromEntries(
			Object.entries(input.inputs).filter(([, value]) => value !== ""),
		);

	const version =
		prepared.version ??
		input.version ??
		(await getTemplateVersions(input.templateId)).defaultRef ??
		undefined;
	if (!version) {
		throw new AppError("TEMPLATE_NO_STABLE_VERSION");
	}

	const appId = randomUUID();
	const folder = appFolderName(manifest.id, appId);
	let primaryHost = "";
	let provider: string | null = null;
	if (manifest.domains.length === 0) {
		// Nothing routed (databases): no domain at all.
	} else if (input.domain) {
		try {
			primaryHost = assertHostname(input.domain);
		} catch {
			throw new AppError("DOMAIN_INVALID", { host: input.domain });
		}
	} else {
		const config = getConfig();
		const ips = await resolveServerIps(server);
		if (ips.length === 0) {
			throw new AppError("DOMAIN_SERVER_IP_UNKNOWN");
		}
		const free = getFreeDomainProvider(config.FREE_DOMAIN_PROVIDER);
		// Named after the app ("my-blog.<ip>.sslip.io"); the folder's id
		// suffix is added only when that host is already taken.
		const label = hostLabelFromName(input.name);
		const candidates = [
			...(label ? [label, `${label}-${folder.slice(-4)}`] : []),
			folder,
		];
		primaryHost = free.hostFor(candidates[candidates.length - 1], ips[0]);
		for (const candidate of candidates) {
			const host = free.hostFor(candidate, ips[0]);
			if (await isFreeHostUnused(host, manifest.domains.length)) {
				primaryHost = host;
				break;
			}
		}
		provider = free.id;
	}
	if (primaryHost) await assertHostAvailable(primaryHost);

	const primarySpec =
		manifest.domains.find((d) => d.primary) ?? manifest.domains[0];
	const domainRows = manifest.domains.map((spec) => ({
		appId,
		host:
			spec === primarySpec
				? primaryHost
				: assertHostname(
						templateDomainHost({ ...spec, primary: false }, primaryHost),
					),
		service: spec.service,
		port: spec.port,
		https: spec.https,
		primary: spec === primarySpec,
		provider,
		viaTunnel: server.tunnelOnly,
	}));

	// Secondary hosts (<service>.<domain>) may not claim the panel's host.
	for (const row of domainRows) await assertHostAvailable(row.host);
	if (extra.dryRender) {
		await dryRenderNewApp({
			templateId: input.templateId,
			version,
			appId,
			name: input.name,
			domain: primaryHost || undefined,
			inputs: overrides,
		});
	}
	try {
		return await db.transaction(async (tx) => {
			const [row] = await tx
				.insert(apps)
				.values({
					id: appId,
					teamId: actor.teamId,
					userId: actor.userId,
					serverId: server.id,
					name: input.name,
					templateId: manifest.id,
					version,
					folder,
					status: "pending",
					inputs: patchAppInputs(
						{ inputs: {} },
						extra.resources
							? { overrides, resources: extra.resources }
							: { overrides },
					),
					customSpecEncrypted: input.custom
						? encryptCustomSpec(input.custom)
						: null,
				})
				.returning();
			if (domainRows.length) await tx.insert(domains).values(domainRows);
			await prepared.persist?.(tx, row.id);
			return row;
		});
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw new AppError("DOMAIN_TAKEN", { host: primaryHost });
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Env editor & credentials

async function secretKeysFor(app: AppRow, values: Record<string, string>) {
	const manifest = await getAppManifest(app);
	const config = getConfig();
	// Name- and value-based fallback so upstream secrets (e.g. SMTP_PASS, or a
	// DB_URL with its password) are masked too.
	const keys = secretEnvKeys({
		values,
		templateSecrets: Object.entries(manifest.variables)
			.filter(([, variable]) => variable.secret)
			.map(([name]) => name),
		namePattern: config.SECRET_ENV_NAME_PATTERN,
		valuePattern: config.SECRET_ENV_VALUE_PATTERN,
	});
	return { manifest, keys };
}

/**
 * Values of the app's secrets (template `secret` variables, names matching
 * SECRET_ENV_NAME_PATTERN, values matching SECRET_ENV_VALUE_PATTERN,
 * service env secrets), for masking command
 * output. Short values are left out (they would mask ordinary words).
 */
export async function appSecretValues(app: AppRow): Promise<string[]> {
	const values = currentValues(app);
	const { keys } = await secretKeysFor(app, values).catch(() => ({
		keys: new Set<string>(),
	}));
	const out = [...keys].map((key) => values[key]).filter(Boolean);
	for (const env of Object.values(readServiceEnv(app))) {
		out.push(...Object.values(env));
	}
	return out.filter((value) => value.length >= 6);
}

function templateKeysFor(app: AppRow, variables: Record<string, unknown>) {
	return new Set([
		...(appInputs(app).templateKeys ?? []),
		...Object.keys(variables),
	]);
}

/**
 * Names the app was initialised with (`AppInputs.initialised`, set when a
 * deploy first reaches `compose up`); null: it never started. Rows from
 * before the marker count as initialised with their stored env once a
 * deploy succeeded.
 */
export function appInitialised(
	app: Pick<AppRow, "composeDeployed" | "envEncrypted" | "inputs">,
): string[] | null {
	const marker = appInputs(app).initialised;
	if (marker) return marker;
	return app.composeDeployed ? Object.keys(readEnvValues(app)) : null;
}

/** Current env: last deployed values plus pending edits (overrides). */
function currentValues(app: AppRow): Record<string, string> {
	return { ...readEnvValues(app), ...appOverrides(app) };
}

export async function getAppEnv(
	actor: Actor,
	appId: string,
): Promise<AppEnvView> {
	const app = await getAppRow(actor, appId);
	const values = currentValues(app);
	const { manifest, keys } = await secretKeysFor(app, values);
	const templateKeys = templateKeysFor(app, manifest.variables);
	const overrides = appOverrides(app);
	const initialised = appInitialised(app);
	const frozen = frozenInitialValues(manifest.variables, initialised);
	// Template order first (the order the template lists its variables).
	const names = [
		...Object.keys(manifest.variables).filter((name) => name in values),
		...Object.keys(values).filter((name) => !(name in manifest.variables)),
	];
	return {
		text: maskedEnvText(values, keys),
		variables: names.map((name): AppEnvVariable => {
			const variable = manifest.variables[name];
			const template = templateKeys.has(name);
			return {
				name,
				template,
				secret: keys.has(name),
				label: variable?.label,
				description: variable?.description,
				group: variable?.group,
				generated: !!variable && isGeneratedExpression(variable.value),
				rotatable: !!variable?.rotatable,
				rotateHook: rotateHookView(variable?.on_rotate),
				locked: !!variable && (!variable.editable || frozen.has(name)),
				initialOnly: variable?.initial_only
					? frozen.has(name)
						? "applied"
						: initialised
							? "not_applied"
							: "first_start"
					: undefined,
				permission: variable?.permission,
				overridden: template && name in overrides,
			};
		}),
		needsRedeploy: app.needsRedeploy,
		version: envVersion(app),
	};
}

export async function revealAppEnv(
	actor: Actor,
	appId: string,
): Promise<string> {
	const app = await getAppRow(actor, appId);
	audit({
		actor,
		action: "app.env.reveal",
		targetType: "app",
		targetId: appId,
	});
	const values = currentValues(app);
	return maskedEnvText(values, new Set());
}

/**
 * Opaque version of an app's stored env (values and overrides): changes
 * whenever either is written (edits, deploys, rotations).
 */
export function envVersion(
	app: Pick<AppRow, "envEncrypted" | "inputs">,
): string {
	return createHash("sha256")
		.update(app.envEncrypted ?? "")
		.update("\0")
		.update(JSON.stringify(appOverrides(app)))
		.digest("hex")
		.slice(0, 32);
}

/**
 * Apply an env editor save: the changed variables (`set`, `remove`), then
 * the template variables handed back to the template (`reset`). Refused when
 * the stored env changed since the editor loaded `version`. Takes effect on
 * the next (re)deploy.
 */
export async function updateAppEnv(
	actor: Actor,
	appId: string,
	edit: AppEnvEdit,
): Promise<AppEnvView & { kept: string[]; changed: string[] }> {
	const owned = await getAppRow(actor, appId);
	const summary = await withAppServerLock(owned, async () => {
		// Re-read under the lock: the row may have changed since.
		const app = await getAppRow(actor, appId);
		if (envVersion(app) !== edit.version) {
			throw new AppError("ENV_CHANGED_SINCE_LOAD");
		}
		const manifest = await getAppManifest(app);
		const deployed = readEnvValues(app);
		const overrides = appOverrides(app);
		const templateKeys = templateKeysFor(app, manifest.variables);
		const definitions = Object.fromEntries(
			Object.entries(manifest.variables).map(([name, variable]) => [
				name,
				variable.value,
			]),
		);
		// Input problems throw coded TemplateErrors.
		const edited = applyEnvChanges({
			set: edit.set,
			remove: edit.remove,
			values: currentValues(app),
			overrides,
			templateKeys,
			definitions,
		});
		const {
			reset,
			touched: dropped,
			keepStored,
			...reverted
		} = applyEnvReset(edited, edit.reset, { templateKeys, definitions });
		// Locked by the template (e.g. an encryption key): never replaced
		// by hand, from the form or the raw view alike. Resetting an
		// override one still has (stored before it was locked) only hands
		// it back to the template, so that stays possible.
		assertEditableVariables(manifest.variables, [
			...edited.changed,
			...edit.remove,
			...edit.reset.filter((name) => !(name in overrides)),
		]);
		// The app read its `initial_only` values on its first start and
		// ignores later ones: they can't be changed here any more.
		const frozen = frozenInitialValues(manifest.variables, appInitialised(app));
		const kept = keepFrozenValues(
			frozen,
			[...edited.changed, ...edited.removed, ...reset],
			{ values: currentValues(app), overrides },
			reverted,
		);
		const touched = dropped.filter((name) => !frozen.has(name));
		const result = { ...edited, ...reverted, ...kept };

		assertVariablePermissions(actor, manifest.variables, [
			...result.changed,
			...result.removed,
			...reset,
			...touched,
		]);
		for (const name of result.changed) {
			const variable = manifest.variables[name];
			if (!variable) continue;
			const error = validateVariableValue(
				name,
				variable,
				result.overrides[name],
			);
			if (error) throw templateError(error);
		}
		// Dependents of changed values are dropped from the stored env so the
		// next render regenerates them (e.g. JWTs signed with a new secret).
		// Reset generated values stay stored: the template carries them over.
		const stored = {
			...Object.fromEntries(
				Object.entries(deployed).filter(([name]) => name in result.values),
			),
			...keepStored,
		};
		// A reset generated value keeps its value: nothing to redeploy for it.
		const valuesChanged =
			result.changed.length > 0 ||
			result.removed.length > 0 ||
			touched.length > 0 ||
			reset.some((name) => !(name in keepStored));
		const changedAnything = valuesChanged || reset.length > 0;
		if (changedAnything) {
			await db
				.update(apps)
				.set({
					inputs: patchAppInputs(app, { overrides: result.overrides }),
					envEncrypted:
						app.envEncrypted || Object.keys(keepStored).length
							? encryptEnvValues(stored)
							: null,
					needsRedeploy: app.needsRedeploy || valuesChanged,
					updatedAt: new Date(),
				})
				.where(eq(apps.id, app.id));
			audit({
				actor,
				action: "app.env.update",
				targetType: "app",
				targetId: appId,
				meta: { changed: result.changed, removed: result.removed, reset },
			});
		}
		return {
			kept: result.kept,
			changed: [...result.changed, ...result.removed, ...reset],
		};
	});
	return { ...(await getAppEnv(actor, appId)), ...summary };
}

/** The overview's credentials card (secret values masked). */
export async function listCredentials(app: AppRow): Promise<AppCredential[]> {
	const manifest = await getAppManifest(app).catch(() => null);
	if (!manifest) return [];
	const values = currentValues(app);
	const frozen = frozenInitialValues(manifest.variables, appInitialised(app));
	return (
		Object.entries(manifest.variables)
			// Empty: not generated yet (e.g. a key upstream ships empty until the
			// next deploy generates it).
			.filter(
				([name, variable]) =>
					variable.credential && name in values && values[name] !== "",
			)
			.map(([name, variable]) => ({
				name,
				label: variable.label,
				description: variable.description,
				secret: variable.secret,
				rotatable: variable.rotatable,
				rotateHook: rotateHookView(variable.on_rotate),
				initial: frozen.has(name),
				value: variable.secret ? SECRET_MASK : values[name],
			}))
	);
}

export async function revealCredential(
	actor: Actor,
	appId: string,
	name: string,
): Promise<string> {
	const app = await getAppRow(actor, appId);
	const manifest = await getAppManifest(app);
	const values = currentValues(app);
	if (!manifest.variables[name]?.credential || !(name in values)) {
		throw new AppError("VARIABLE_NOT_CREDENTIAL", { name });
	}
	audit({
		actor,
		action: "app.credential.reveal",
		targetType: "app",
		targetId: appId,
		meta: { name },
	});
	return values[name];
}

/**
 * A variable with a template `permission` (e.g. a URL code is loaded
 * from) needs it, besides the edit permission, to be set or changed.
 */
export function assertVariablePermissions(
	actor: Actor,
	variables: Record<string, { permission?: Permission }>,
	names: Iterable<string>,
): void {
	for (const name of names) {
		const permission = variables[name]?.permission;
		if (permission) assertCanAccess(actor, permission);
	}
}

/**
 * Template variables the template does not let the owner set (`editable`
 * unset: generated keys, values derived from others) are refused (set,
 * removed, or reset without an override to drop). Their values come from
 * the template only: rotation (`rotatable`) and renders replace them
 * through their own paths.
 * Names that are not template variables (custom env) are not checked.
 */
export function assertEditableVariables(
	variables: Record<string, { editable: boolean }>,
	names: Iterable<string>,
): void {
	for (const name of names) {
		const variable = variables[name];
		if (variable && !variable.editable) {
			throw new AppError("VARIABLE_NOT_EDITABLE", { name });
		}
	}
}

/** Destructive actions are confirmed by typing the app's folder (slug). */
export function assertDeleteConfirmation(
	app: Pick<AppRow, "folder">,
	confirmName: string,
) {
	if (confirmName.trim() !== app.folder) {
		throw new AppError("APP_NAME_MISMATCH");
	}
}

// ---------------------------------------------------------------------------
// Service-scoped secret env (template `service_env`)

export async function assertServiceEnvService(
	app: AppRow,
	service: string,
): Promise<void> {
	const manifest = await getAppManifest(app);
	if (!manifest.service_env.includes(service)) {
		throw new AppError("APP_SERVICE_NOT_FOUND", { service });
	}
}

/** Names only: values are write-only from the client's point of view. */
export async function listServiceEnv(
	actor: Actor,
	appId: string,
	service: string,
): Promise<ServiceEnvView> {
	const app = await getAppRow(actor, appId);
	await assertServiceEnvService(app, service);
	return {
		names: Object.keys(readServiceEnv(app)[service] ?? {}).sort(),
		applied: isServiceEnvDeployed(app, service),
	};
}

/** Whether the deployed compose already reads the service's env file. */
export function isServiceEnvDeployed(
	app: Pick<AppRow, "composeDeployed" | "folder" | "id">,
	service: string,
): boolean {
	const file = `${appLocation(app).appRoot}/${serviceEnvFile(service)}`;
	return !!app.composeDeployed?.includes(file);
}

/** Env names the service's compose `environment` sets (they would win). */
export function composeEnvironmentNames(
	app: Pick<AppRow, "composeDeployed">,
	service: string,
): Set<string> {
	if (!app.composeDeployed) return new Set();
	const model = parseYaml(app.composeDeployed) as {
		services?: Record<string, { environment?: unknown }>;
	};
	const environment = model?.services?.[service]?.environment;
	const names = Array.isArray(environment)
		? environment.map((item) => String(item).split("=")[0])
		: Object.keys((environment as Record<string, unknown>) ?? {});
	return new Set(names);
}

// ---------------------------------------------------------------------------
// Published ports (template `[[ports]]`, opt-in)

/** Host ports currently listening on the server (`ss`). */
async function listeningPorts(server: ServerRow): Promise<Set<number>> {
	const executor = await getExecutor(server);
	try {
		const result = await executor.exec("ss -Htln 2>/dev/null || true");
		const ports = new Set<number>();
		for (const line of result.stdout.split("\n")) {
			const local = line.trim().split(/\s+/)[3] ?? "";
			const port = Number(local.slice(local.lastIndexOf(":") + 1));
			if (Number.isInteger(port) && port > 0) ports.add(port);
		}
		return ports;
	} finally {
		executor.close();
	}
}

/**
 * Enable/disable published ports. Takes effect on the next redeploy. Ports
 * must be unprivileged, not reserved, unique on the server and free.
 */
export async function setPublishedPorts(
	actor: Actor,
	appId: string,
	ports: Record<string, number | null>,
	loopback?: string[],
): Promise<void> {
	const owned = await getAppRow(actor, appId);
	// Serialised with jobs on this server: no deploy can overwrite `inputs`
	// meanwhile, and the cross-app uniqueness check can't race another save.
	await withAppServerLock(owned, () =>
		savePublishedPorts(actor, appId, ports, loopback),
	);
}

async function savePublishedPorts(
	actor: Actor,
	appId: string,
	ports: Record<string, number | null>,
	loopback?: string[],
): Promise<void> {
	const app = await getAppRow(actor, appId);
	const manifest = await getAppManifest(app);
	const config = getConfig();
	const inputs = appInputs(app);
	const current = inputs.publishedPorts ?? {};
	const next: Record<string, number> = { ...current };
	for (const [id, hostPort] of Object.entries(ports)) {
		if (!manifest.ports.some((port) => port.id === id)) {
			throw new AppError("TEMPLATE_PORT_UNKNOWN", { port: id });
		}
		if (hostPort === null) delete next[id];
		else next[id] = hostPort;
	}
	const wanted = Object.values(next);
	const duplicate = wanted.find(
		(port, index) => wanted.indexOf(port) !== index,
	);
	if (duplicate !== undefined) {
		throw new AppError("PORT_DUPLICATE", { port: String(duplicate) });
	}
	const added = Object.entries(next).filter(
		([id, port]) => current[id] !== port,
	);
	if (added.length) {
		const others = await db
			.select({ id: apps.id, inputs: apps.inputs })
			.from(apps)
			.where(eq(apps.serverId, app.serverId));
		const taken = new Set(
			others
				.filter((other) => other.id !== app.id)
				.flatMap((other) => Object.values(other.inputs?.publishedPorts ?? {})),
		);
		const listening = await listeningPorts(await getAppServer(app));
		const own = new Set(Object.values(current));
		for (const [, port] of added) {
			const params = { port: String(port) };
			if (config.APP_RESERVED_HOST_PORTS.includes(port)) {
				throw new AppError("PORT_RESERVED", params);
			}
			if (taken.has(port)) throw new AppError("PORT_TAKEN", params);
			if (listening.has(port) && !own.has(port)) {
				throw new AppError("PORT_IN_USE", params);
			}
		}
	}
	await db
		.update(apps)
		.set({
			inputs: patchAppInputs(app, {
				publishedPorts: next,
				// Only ports that are published can be loopback-bound.
				loopbackPorts: (loopback ?? inputs.loopbackPorts ?? []).filter(
					(id) => id in next,
				),
			}),
			needsRedeploy: true,
			updatedAt: new Date(),
		})
		.where(eq(apps.id, app.id));
	audit({
		actor,
		action: "app.ports.update",
		targetType: "app",
		targetId: appId,
		meta: { ports: next, loopback: loopback ?? inputs.loopbackPorts ?? [] },
	});
}
