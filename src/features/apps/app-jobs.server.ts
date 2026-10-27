import { eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { matchFailureSignature } from "#/config/failure-signatures.ts";
import type { JobLogEvent } from "#/config/job-log-events.ts";
import { type JobTitle, jobTitle } from "#/config/job-titles.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { type AppInputs, apps } from "#/db/schema/apps.ts";
import { deployments } from "#/db/schema/server.ts";
import { type Actor, assertCanAccess } from "#/features/auth/access.ts";
import { backupFirstStep } from "#/features/backups/jobs.server.ts";
import {
	type JobContext,
	type JobLogger,
	type JobOutcome,
	startJob,
	withAppServerLock,
} from "#/features/deployments/deployments.server.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import {
	hasOrderedVersions,
	type TemplateManifest,
	type TemplateRotateHook,
} from "#/features/templates/schema.ts";
import {
	getTemplateManifest,
	isSecretFile,
	type RenderedTemplate,
	renderTemplate,
	serviceEnvFile,
} from "#/features/templates/templates.server.ts";
import { sleep } from "#/libs/async.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import {
	type DowngradeRisk,
	downgradeRisk,
} from "#/server/services/app-updates/policy.ts";
import {
	type AppLocation,
	appDataBindDirs,
	appDataDirsScript,
	appEnvProbeScript,
	assertServiceName,
	BIND_FILE_MISSING_EXIT,
	type BindFileExpectations,
	bindSourcesCheckScript,
	chmodExecutableCommand,
	composeConfigCommand,
	composeDownCommand,
	composeIdentityCommand,
	composeLogsCommand,
	composeOomCommand,
	composePrepareCommand,
	composeRecreateServiceCommand,
	composeRestartServicesCommand,
	composeServiceCommand,
	composeStatusCommand,
	composeUpCommand,
	emptyDirsAtFilesScript,
	httpProbeCommand,
	isHealthyStatus,
	parseAppEnvProbe,
	parseBindFileMissing,
	parseBindFileWarnings,
	parseImageList,
	parseServiceStatus,
	projectImagesCommand,
	removeAppFolderCommand,
	removeFileCommand,
	removeImagesScript,
	resolvedBindSources,
	type ServiceAction,
	type ServiceStatus,
} from "#/server/services/apps/commands.ts";
import {
	composeDependsOn,
	dependentsToRestart,
	type ProjectIdentities,
	parseContainerIdentities,
} from "#/server/services/apps/dependents.ts";
import {
	diffEnvKeys,
	diffLines,
	formatUnifiedDiff,
} from "#/server/services/apps/diff.ts";
import {
	carryOverValues,
	editServiceEnv,
	frozenInitialValues,
	initialisedNames,
	isGeneratedExpression,
	rotationDrops,
} from "#/server/services/apps/env-state.ts";
import { parseOomKills } from "#/server/services/apps/oom.ts";
import {
	ReadinessTracker,
	type ReadinessVerdict,
} from "#/server/services/apps/readiness.ts";
import { nextStoppedServices } from "#/server/services/apps/stopped-services.ts";
import { audit } from "#/server/services/audit.ts";
import { errorInfoOf, lastErrorColumns } from "#/server/services/error-info.ts";
import type { Executor } from "#/server/services/executor.ts";
import { APP_OWNER_FILE } from "#/server/services/ownership.ts";
import { assertServerOwned } from "#/server/services/server-setup.ts";
import {
	formatPsqlError,
	psqlCommand,
} from "#/server/services/supabase/sql.ts";
import type {
	AppBindSource,
	FileBinds,
} from "#/server/services/templates/bind-sources.ts";
import {
	assertSafeCompose,
	parseLinkNetworkName,
} from "#/server/services/templates/compose-policy.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { LINKS_ENV_FILE } from "#/server/services/templates/render.ts";
import { effectiveLimits } from "#/server/services/templates/resources.ts";
import {
	bcryptHasher,
	withPathRoutes,
	withRouteAuth,
} from "#/server/services/templates/route-auth.ts";
import {
	generateTraefikDynamic,
	servedThroughTunnel,
	traefikAppKey,
} from "#/server/services/templates/traefik-dynamic.ts";
import {
	parseRenderedEnvFile,
	renderEnvFile,
} from "#/server/services/templates/variables.ts";
import {
	AppError,
	coded,
	commandError,
	type DetailErrorCode,
} from "#/utils/error.ts";
import {
	appInitialised,
	appInputs,
	appLocation,
	appOverrides,
	appTraefikPath,
	assertDeleteConfirmation,
	assertServiceEnvService,
	composeEnvironmentNames,
	containerName,
	createAppRecord,
	deployedEnvColumns,
	deployedEnvValues,
	deployedServices,
	encryptEnvValues,
	encryptServiceEnv,
	getAppManifest,
	getAppRow,
	getAppServer,
	isServiceEnvDeployed,
	listAppDomains,
	patchAppInputs,
	pendingEnvColumns,
	readEnvValues,
	readServiceEnv,
} from "./apps.server";
import type {
	AppRow,
	AppUpdatePreview,
	CreateAppInput,
	DomainRow,
} from "./schema";
import {
	isVersionedSource,
	type SourceRequest,
	sourceDriver,
	sourceKindOf,
} from "./sources.server";

/** Database links (lazy: the module imports the app modules). */
const linksModule = () => import("#/features/databases/links.server.ts");

export type DeployMode = "deploy" | "redeploy" | "update";

/** Domain checks shortly after routes change (lazy import: no cycle). */
function recheckDomainsLater(appId: string): void {
	void import("./domains.server")
		.then((module) => module.scheduleDomainChecks(appId))
		.catch(() => {});
}

/**
 * Version changes only exist for templates with upstream versions. A custom
 * compose changes through its own (audited) edit flow; its diff is never
 * served from here.
 */
async function assertVersioned(app: AppRow): Promise<TemplateManifest> {
	const manifest = await getTemplateManifest(app.templateId);
	if (!isVersionedSource(manifest)) {
		throw new AppError("APP_NOT_VERSIONED");
	}
	return manifest;
}

/**
 * Whether moving the app to `version` is a downgrade, and how risky
 * (template `[updates].rollback = "restore"`: irreversible migrations).
 * Null for upgrades and for versions that do not compare (branches,
 * commits).
 */
export function versionChangeRisk(
	app: Pick<AppRow, "version">,
	version: string,
	manifest: Pick<TemplateManifest, "source" | "updates">,
): DowngradeRisk | null {
	return downgradeRisk({
		from: app.version,
		to: version,
		ordered: hasOrderedVersions(manifest.source),
		rollback: manifest.updates.rollback,
	});
}

/** Built from the owner's repository (source kind `git`). */
async function isGitApp(app: Pick<AppRow, "templateId">): Promise<boolean> {
	return sourceKindOf(await getTemplateManifest(app.templateId)) === "git";
}

/** Log a tolerated problem as a warning event. */
export function logWarning(ctx: JobLogger, error: unknown): void {
	ctx.event("job.warning", { warning: { $error: errorInfoOf(error) } });
}

/**
 * What a failed command throws: a coded step whose only param is the
 * command's output, or a builder for codes with more params.
 */
export type CommandFailure = DetailErrorCode | ((detail: string) => AppError);

/**
 * Run a command streaming its output to the job log; a non-zero exit
 * throws `failure` (a coded step) with the command's output as detail.
 */
export async function run(
	executor: Executor,
	ctx: JobContext,
	command: string,
	failure: CommandFailure,
	options: { quiet?: boolean; timeoutMs?: number } = {},
): Promise<string> {
	const result = await executor.exec(command, {
		timeoutMs: options.timeoutMs,
		signal: ctx.signal,
		onStdout: options.quiet ? undefined : (chunk) => ctx.log(chunk),
		onStderr: options.quiet ? undefined : (chunk) => ctx.log(chunk),
	});
	if (result.exitCode !== 0) {
		const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
		throw typeof failure === "function"
			? failure(detail)
			: commandError(failure, detail);
	}
	return result.stdout;
}

/**
 * Run `task`, calling `beat(elapsedMs)` every `intervalMs` until it settles
 * (a long, silent step such as `docker compose pull --quiet` shows it is
 * still going; one line per interval keeps the log bounded).
 */
export async function withHeartbeat<T>(
	intervalMs: number,
	beat: (elapsedMs: number) => void,
	task: () => Promise<T>,
): Promise<T> {
	const started = Date.now();
	const timer =
		intervalMs > 0
			? setInterval(() => beat(Date.now() - started), intervalMs)
			: null;
	try {
		return await task();
	} finally {
		if (timer) clearInterval(timer);
	}
}

function routesFromDomains(rows: DomainRow[]) {
	return rows.map((row) => ({
		host: row.host,
		service: row.service,
		port: row.port,
		https: row.https,
	}));
}

export async function setStatus(
	appId: string,
	patch: Partial<typeof apps.$inferInsert>,
): Promise<void> {
	await db
		.update(apps)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(apps.id, appId));
}

async function freshApp(appId: string): Promise<AppRow> {
	const [row] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	if (!row) throw new AppError("APP_NOT_FOUND");
	return row;
}

/** Render the app for `mode`, reusing its env state. No side effects. */
export async function renderApp(
	app: AppRow,
	mode: DeployMode,
	version?: string,
	/** The server it deploys to (its resource policy); default: the app's. */
	target?: Pick<ServerRow, "requireLimits" | "defaultMemoryMb">,
	/** Owner-defined sources: the commit to render (git: the image to run). */
	sourceCommit?: string,
	/**
	 * Values to carry generated ones over from instead of the stored env
	 * (an interrupted first deploy's `.env` read back from the server).
	 */
	previous?: Record<string, string>,
): Promise<RenderedTemplate> {
	const appDomains = await listAppDomains(app.id);
	const primary = appDomains.find((domain) => domain.primary);
	if (!primary && appDomains.length) {
		throw new TemplateError("APP_NO_PRIMARY_DOMAIN");
	}
	const manifest = await getAppManifest(app);
	const expressions = Object.fromEntries(
		Object.entries(manifest.variables).map(([name, variable]) => [
			name,
			variable.value,
		]),
	);
	const base = await getTemplateManifest(app.templateId);
	const source = await (await sourceDriver(base)).renderInput(base, app, {
		commitSha: sourceCommit ?? app.commitSha ?? undefined,
		version: mode === "update" ? version : undefined,
	});
	const links = await (await linksModule()).appLinkRender(app);
	return renderTemplate({
		templateId: app.templateId,
		appId: app.id,
		appName: app.name,
		version: mode === "update" ? version : app.version,
		// Redeploys reuse the exact commit; first deploys and updates resolve it.
		commitSha: mode === "redeploy" && app.commitSha ? app.commitSha : undefined,
		domain: primary?.host ?? `${app.folder}.invalid`,
		routes: appDomains.length ? routesFromDomains(appDomains) : undefined,
		overrides: appOverrides(app),
		existing: carryOverValues(
			expressions,
			previous ?? readEnvValues(app),
			// Read by the app on its first start only: kept as they were.
			frozenInitialValues(manifest.variables, appInitialised(app)),
		),
		allowCustomOverrides: true,
		publishedPorts: appInputs(app).publishedPorts,
		loopbackPorts: appInputs(app).loopbackPorts,
		serviceEnv: readServiceEnv(app),
		resources: appInputs(app).resources,
		linkNetworks: links.linkNetworks,
		linkEnv: links.linkEnv,
		fallbackResources:
			target?.requireLimits && target.defaultMemoryMb
				? { memoryMb: target.defaultMemoryMb }
				: undefined,
		source: source ?? undefined,
	});
}

/** A server that requires limits refuses services rendered without one. */
function assertRenderedLimits(
	rendered: RenderedTemplate,
	server: Pick<ServerRow, "requireLimits">,
): void {
	if (!server.requireLimits) return;
	const services = (rendered.composeModel.services ?? {}) as Record<
		string,
		unknown
	>;
	for (const [name, service] of Object.entries(services)) {
		if (!effectiveLimits(service).memoryMb) {
			throw new AppError("RESOURCES_REQUIRED", { service: name });
		}
	}
}

export async function uploadRendered(
	executor: Executor,
	location: AppLocation,
	rendered: RenderedTemplate,
	ctx: JobContext,
): Promise<void> {
	ctx.event("deploy.writing_files", {
		count: rendered.files.length + 2,
		path: location.appRoot,
	});
	// Ownership marker first: other panels on this server never wipe this
	// folder, and a retried deploy may read back its `.env` (see
	// `probeServerEnv`) even when this upload is interrupted.
	await executor.upload(
		`${await requireInstanceId()}\n`,
		`${location.appRoot}/${APP_OWNER_FILE}`,
		"0644",
	);
	if (rendered.files.length > 0) {
		const replaced = await run(
			executor,
			ctx,
			emptyDirsAtFilesScript(
				location,
				rendered.files.map((file) => file.path),
			),
			"APP_FILES_PREPARE_FAILED",
			{ quiet: true },
		);
		for (const line of replaced.split("\n")) {
			if (line.startsWith("replaced=")) {
				ctx.event("deploy.empty_dir_replaced", {
					path: line.slice("replaced=".length),
				});
			}
		}
	}
	for (const file of rendered.files) {
		await executor.upload(
			file.content,
			`${location.appRoot}/${file.path}`,
			isSecretFile(file.path) ? "0600" : undefined,
		);
	}
	const chmod = chmodExecutableCommand(
		location,
		rendered.files.filter((file) => file.executable).map((file) => file.path),
	);
	if (chmod)
		await run(executor, ctx, chmod, "APP_CHMOD_FAILED", { quiet: true });
	// No links any more: their env file must not linger (nor be read).
	if (!rendered.files.some((file) => file.path === LINKS_ENV_FILE)) {
		await run(
			executor,
			ctx,
			removeFileCommand(`${location.appRoot}/${LINKS_ENV_FILE}`),
			"APP_LINKS_ENV_REMOVE_FAILED",
			{ quiet: true },
		);
	}
	await executor.upload(
		rendered.compose,
		`${location.appRoot}/docker-compose.yml`,
		"0644",
	);
	await executor.upload(
		renderEnvFile(rendered.values),
		`${location.appRoot}/.env`,
		"0600",
	);
}

function sameValues(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
	);
}

/**
 * Store the rendered values BEFORE any file holding them reaches the
 * server: a deploy that fails (or is interrupted) after the upload leaves
 * the stored env matching the server's `.env`, so the next render carries
 * the same generated secrets over instead of generating new ones that no
 * longer match data initialised with the first (e.g. a database password).
 * Only the env state moves here; status/version are set on success.
 */
export async function persistRenderedEnv(
	appId: string,
	rendered: Pick<RenderedTemplate, "values" | "definitions">,
): Promise<void> {
	// Fresh read: the job may have changed the row since it started.
	const app = await freshApp(appId);
	const templateKeys = Object.keys(rendered.definitions);
	const storedKeys = appInputs(app).templateKeys;
	if (
		app.envEncrypted &&
		sameValues(readEnvValues(app), rendered.values) &&
		storedKeys?.length === templateKeys.length &&
		templateKeys.every((key) => storedKeys.includes(key))
	) {
		return;
	}
	await setStatus(app.id, {
		// Pending until this deploy succeeds (the live env is kept aside).
		...pendingEnvColumns(app, rendered.values),
		// Those of this render: a rollback drops a failed version's keys.
		inputs: patchAppInputs(app, { templateKeys }),
	});
}

/**
 * An app without stored env (its first deploy never finished): what its
 * server already holds. The `.env` is read back only from a folder this
 * instance owns; its values are secrets (quiet command, never logged).
 */
async function probeServerEnv(
	executor: Executor,
	location: AppLocation,
	ctx: JobContext,
): Promise<{ values: Record<string, string> | null; volumes: number }> {
	const result = await executor.exec(
		appEnvProbeScript(location, await requireInstanceId()),
		{ signal: ctx.signal },
	);
	if (result.exitCode !== 0) {
		// stderr only: stdout may hold the `.env`.
		throw commandError(
			"APP_ENV_PROBE_FAILED",
			result.stderr || `exit ${result.exitCode}`,
		);
	}
	const probe = parseAppEnvProbe(result.stdout);
	return {
		values: probe.envText === null ? null : parseRenderedEnvFile(probe.envText),
		volumes: probe.volumes,
	};
}

/**
 * Safety net: generated secrets were just created anew (nothing stored or
 * recoverable) while the app already has data on the server: warn, since
 * services keeping a secret in their data may now refuse the new one.
 */
async function warnNewSecretsOverData(
	executor: Executor,
	location: AppLocation,
	rendered: RenderedTemplate,
	volumes: number,
	ctx: JobContext,
): Promise<void> {
	if (!Object.values(rendered.definitions).some(isGeneratedExpression)) return;
	let found = volumes > 0;
	if (!found) {
		const dirs = appDataBindDirs(
			location,
			rendered.composeModel,
			rendered.files.map((file) => file.path),
		);
		if (dirs.length === 0) return;
		const output = await run(
			executor,
			ctx,
			appDataDirsScript(dirs),
			"APP_ENV_PROBE_FAILED",
			{ quiet: true },
		);
		found = /data=[1-9]/.test(output);
	}
	if (found) ctx.event("deploy.secrets_new_with_data");
}

/**
 * Validate the compose model exactly as Docker will run it (interpolated
 * with the app's .env), then make sure no bind source goes through a symlink.
 */
export async function verifyResolvedCompose(
	executor: Executor,
	location: AppLocation,
	rendered: RenderedTemplate,
	ctx: JobContext,
): Promise<void> {
	ctx.event("deploy.validating");
	const output = await run(
		executor,
		ctx,
		composeConfigCommand(location),
		"COMPOSE_CONFIG_FAILED",
		{ quiet: true },
	);
	let model: unknown;
	try {
		model = JSON.parse(output);
	} catch {
		throw new AppError("COMPOSE_CONFIG_INVALID");
	}
	assertSafeCompose(model, rendered.policy, "resolved");
	const binds = fileBindsOf(rendered);
	const checked = await run(
		executor,
		ctx,
		bindSourcesCheckScript(
			location,
			resolvedBindSources(model),
			fileBindExpectations(location, binds),
		),
		(detail) =>
			bindFileMissingError(location, binds, detail) ??
			commandError("COMPOSE_UNSAFE_BIND", detail),
		{ quiet: true },
	);
	// Named like a file, written by nothing: maybe the owner's own file;
	// else Docker creates a folder (refused after `up`).
	for (const missing of parseBindFileWarnings(checked)) {
		const bind = bindAt(location, binds, missing);
		ctx.event("deploy.bind_file_warning", {
			service: bind?.service ?? "",
			path: bind?.path ?? missing,
		});
	}
}

/** The rendered file binds (none from renders that predate them). */
function fileBindsOf(rendered: Pick<RenderedTemplate, "fileBinds">): FileBinds {
	return rendered.fileBinds ?? { required: [], named: [] };
}

/** What `bindSourcesCheckScript` expects to be files (absolute paths). */
function fileBindExpectations(
	location: AppLocation,
	binds: FileBinds,
	after = false,
): BindFileExpectations {
	const absolute = (list: AppBindSource[]) =>
		list.map((bind) => `${location.appRoot}/${bind.path}`);
	return {
		files: absolute(binds.required),
		namedFiles: absolute(binds.named),
		after,
	};
}

/** The file bind at an absolute path, if any. */
function bindAt(
	location: AppLocation,
	binds: FileBinds,
	absolute: string,
): AppBindSource | null {
	if (!absolute.startsWith(`${location.appRoot}/`)) return null;
	const rel = absolute.slice(location.appRoot.length + 1);
	return (
		[...binds.required, ...binds.named].find((bind) => bind.path === rel) ?? {
			service: "",
			path: rel,
		}
	);
}

/** TEMPLATE_BIND_SOURCE_MISSING for a failed bind check, if it is one. */
function bindFileMissingError(
	location: AppLocation,
	binds: FileBinds,
	stderr: string,
): AppError | null {
	const missing = parseBindFileMissing(stderr);
	const bind = missing ? bindAt(location, binds, missing) : null;
	return bind
		? new AppError("TEMPLATE_BIND_SOURCE_MISSING", {
				service: bind.service,
				path: bind.path,
			})
		: null;
}

/**
 * Close the check→up window: if a bind source became a symlink meanwhile,
 * stop the app and fail loudly. A bind source expected to be a file that
 * is not (an empty directory Docker created) fails the deploy too.
 */
export async function recheckBindSources(
	executor: Executor,
	location: AppLocation,
	ctx: JobContext,
	fileBinds?: FileBinds,
): Promise<void> {
	const binds = fileBinds ?? { required: [], named: [] };
	const output = await run(
		executor,
		ctx,
		composeConfigCommand(location),
		"COMPOSE_CONFIG_FAILED",
		{ quiet: true },
	);
	const check = await executor.exec(
		bindSourcesCheckScript(
			location,
			resolvedBindSources(JSON.parse(output)),
			fileBindExpectations(location, binds, true),
		),
	);
	if (check.exitCode === BIND_FILE_MISSING_EXIT) {
		const error = bindFileMissingError(location, binds, check.stderr);
		if (error) throw error;
	}
	if (check.exitCode !== 0) {
		await executor.exec(composeServiceCommand(location, "stop"));
		throw commandError("COMPOSE_BIND_SYMLINK", check.stderr);
	}
}

/**
 * Services with a container the kernel killed for memory under a memory
 * limit since `since` (when the deploy started its containers, ms), as
 * coded hints by service: an older kill (`OOMKilled` stays set until the
 * container exits again or is recreated) explains nothing. The window is a
 * duration compared on the host's own clock, so clock skew does not
 * matter. A failed read yields none: a hint must never replace the failure
 * it explains.
 */
async function readOomHints(
	executor: Executor,
	location: AppLocation,
	signal: AbortSignal | undefined,
	since: number,
): Promise<Map<string, ErrorInfo>> {
	const result = await executor
		.exec(composeOomCommand(location), { signal })
		.catch(() => null);
	const hints = new Map<string, ErrorInfo>();
	if (!result || result.exitCode !== 0) return hints;
	const withinSeconds = Math.ceil(Math.max(0, Date.now() - since) / 1000);
	for (const { service, limitMb } of parseOomKills(result.stdout, {
		withinSeconds,
	})) {
		hints.set(service, coded("SERVICE_OOM_KILLED", { service, limitMb }));
	}
	return hints;
}

/**
 * A service down because it failed: restarting, or exited with an error
 * (exit 0 is a one-shot service that finished, see `ReadinessTracker`).
 */
export function isCrashing({
	state,
	exitCode,
}: Pick<ServiceStatus, "state" | "exitCode">): boolean {
	return state === "restarting" || (state === "exited" && exitCode !== 0);
}

/**
 * Known failure signatures (`#/config/failure-signatures.ts`) in the logs
 * of services that crash-loop while a deploy waits: each match is logged
 * once as a coded hint, and the readiness error carries the first one (it
 * becomes the app's error). The logs themselves are never written to the
 * job log (they may hold secrets). An out-of-memory kill during the deploy
 * is named the same way.
 */
class FailureHints {
	private readonly reads = new Map<string, number>();
	private readonly found = new Map<string, ErrorInfo>();
	private oomReads = 0;

	constructor(
		private readonly executor: Executor,
		private readonly location: AppLocation,
		private readonly manifest: Pick<TemplateManifest, "failure_hints">,
		private readonly ctx: JobContext,
		/** When the deploy started its containers (ms): older kills are stale. */
		private readonly since: number,
	) {}

	/**
	 * `looping`: the service the readiness verdict found crash-looping; it
	 * may be seen running between two restarts, and is still worth a hint.
	 */
	async inspect(statuses: ServiceStatus[], looping?: string): Promise<void> {
		await this.inspectOom(statuses, looping);
		for (const status of statuses) {
			const { service } = status;
			if (!isCrashing(status) && service !== looping) continue;
			if (this.found.has(service)) continue;
			const reads = this.reads.get(service) ?? 0;
			// A service may log its failure late: a few reads per wait.
			if (reads >= getConfig().APP_HINT_MAX_READS) continue;
			this.reads.set(service, reads + 1);
			const result = await this.executor
				.exec(
					composeLogsCommand(this.location, {
						service,
						tail: getConfig().APP_HINT_LOG_LINES,
						follow: false,
						timestamps: false,
					}),
					{ signal: this.ctx.signal },
				)
				.catch(() => null);
			if (!result || result.exitCode !== 0) continue;
			const hint = matchFailureSignature(
				`${result.stdout}\n${result.stderr}`,
				service,
				this.manifest.failure_hints,
			);
			if (!hint) continue;
			this.found.set(service, hint);
			this.ctx.event("deploy.failure_hint", { hint: { $error: hint } });
		}
	}

	/** A crash-looping service the kernel killed for memory: name its limit. */
	private async inspectOom(
		statuses: ServiceStatus[],
		looping: string | undefined,
	): Promise<void> {
		const failing = new Set(
			statuses.filter(isCrashing).map(({ service }) => service),
		);
		if (looping) failing.add(looping);
		if (failing.size === 0) return;
		if (this.oomReads >= getConfig().APP_HINT_MAX_READS) return;
		this.oomReads += 1;
		const hints = await readOomHints(
			this.executor,
			this.location,
			this.ctx.signal,
			this.since,
		);
		for (const [service, hint] of hints) {
			if (!failing.has(service) || this.found.has(service)) continue;
			this.found.set(service, hint);
			this.ctx.event("deploy.failure_hint", { hint: { $error: hint } });
		}
	}

	/** The readiness error, with the first hint found (if any). */
	wrap(error: AppError, status: string): AppError {
		const [hint] = this.found.values();
		return hint
			? new AppError("APP_NOT_READY_HINT", { status, hint: { $error: hint } })
			: error;
	}
}

/** What the readiness wait reads of a render: the probed route's container. */
type ReadinessTarget = Pick<RenderedTemplate, "routes" | "containerNames">;

/** Readiness error of a failed sample (`ReadinessTracker`). */
function readinessError(
	verdict: Extract<ReadinessVerdict, { state: "failed" }>,
): AppError {
	return verdict.failure.kind === "restart_loop"
		? new AppError("APP_RESTART_LOOP", {
				service: verdict.failure.service,
				restarts: verdict.failure.restarts,
			})
		: new AppError("APP_UNHEALTHY", { status: verdict.detail });
}

/**
 * Wait until the app's containers are ready and stay so (see
 * `ReadinessTracker`), probe `[health]`, then sample once more: a service
 * that restarted during the wait is named in a warning, one that
 * crash-loops fails the deploy (`APP_RESTART_LOOP`).
 */
export async function waitUntilHealthy(
	executor: Executor,
	location: AppLocation,
	rendered: ReadinessTarget,
	app: AppRow,
	ctx: JobContext,
	/** When the deploy started the containers (ms; dates the OOM hints). */
	since: number = Date.now(),
): Promise<void> {
	const config = getConfig();
	const manifest = await getAppManifest(app);
	const timeoutMs = manifest.health?.timeout_seconds
		? manifest.health.timeout_seconds * 1000
		: config.APP_HEALTH_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	let lastDetail: string | null = null;
	const hints = new FailureHints(executor, location, manifest, ctx, since);
	const tracker = new ReadinessTracker({
		restartLimit:
			manifest.health?.restart_limit ?? config.APP_DEPLOY_RESTART_LIMIT,
		stableMs:
			manifest.health?.stable_seconds !== undefined
				? manifest.health.stable_seconds * 1000
				: config.APP_READY_STABLE_MS,
		stableSamples: config.APP_READY_STABLE_SAMPLES,
		unhealthyGraceMs:
			manifest.health?.unhealthy_grace_seconds !== undefined
				? manifest.health.unhealthy_grace_seconds * 1000
				: config.APP_UNHEALTHY_GRACE_MS,
		unhealthySamples: config.APP_UNHEALTHY_SAMPLES,
	});
	const sample = async (): Promise<ReadinessVerdict> => {
		const statuses = parseServiceStatus(
			await run(
				executor,
				ctx,
				composeStatusCommand(location),
				"COMPOSE_PS_FAILED",
				{ quiet: true },
			),
		);
		const verdict = tracker.observe(statuses, Date.now());
		if (verdict.detail !== lastDetail) {
			if (verdict.detail) {
				ctx.event("deploy.status", { status: verdict.detail });
			} else {
				ctx.event("deploy.no_containers");
			}
			lastDetail = verdict.detail;
		}
		if (verdict.state !== "ready") {
			await hints.inspect(
				statuses,
				verdict.state === "failed" && verdict.failure.kind === "restart_loop"
					? verdict.failure.service
					: undefined,
			);
		}
		if (verdict.state === "failed") {
			throw hints.wrap(readinessError(verdict), verdict.detail);
		}
		return verdict;
	};

	ctx.event("deploy.waiting_ready");
	for (;;) {
		const verdict = await sample();
		if (verdict.state === "ready") break;
		if (Date.now() > deadline) {
			// Still unhealthy (within its grace) at the deadline: say so.
			throw hints.wrap(
				tracker.unhealthyNow
					? new AppError("APP_UNHEALTHY", { status: verdict.detail })
					: new AppError("APP_READY_TIMEOUT", { status: verdict.detail }),
				verdict.detail,
			);
		}
		await sleep(config.APP_HEALTH_INTERVAL_MS);
	}

	await probeHealth(executor, rendered, manifest, deadline, ctx);

	// The probe may take a while: a service may have crashed meanwhile.
	await sample();
	const restarted = tracker.restarted();
	if (restarted.length) {
		ctx.event("job.warning", {
			warning: {
				$error: coded("APP_SERVICES_RESTARTED", {
					services: {
						$list: restarted.map(
							({ service, restarts }) => `${service} (↻${restarts})`,
						),
					},
				}),
			},
		});
	}
}

/** `[health]` HTTP probe from the proxy network (none without a path). */
async function probeHealth(
	executor: Executor,
	rendered: ReadinessTarget,
	manifest: Pick<TemplateManifest, "health">,
	deadline: number,
	ctx: JobContext,
): Promise<void> {
	const config = getConfig();
	const health = manifest.health;
	const route = rendered.routes[0];
	const service = health?.service ?? route?.service;
	const port = health?.port ?? route?.port;
	if (!health?.path || !service || !port) return;
	const container = rendered.containerNames[service];
	if (!container) throw new AppError("APP_HEALTH_SERVICE_MISSING", { service });

	ctx.event("deploy.probing", {
		url: `http://${service}:${port}${health.path}`,
	});
	const probe = httpProbeCommand({
		network: config.NITROBASE_NETWORK,
		image: config.APP_HEALTH_IMAGE,
		container,
		port,
		path: health.path,
	});
	for (;;) {
		const result = await executor.exec(probe, {
			timeoutMs: config.APP_HEALTH_PROBE_TIMEOUT_MS,
		});
		const code = Number.parseInt(result.stdout.slice(-3), 10);
		if (result.exitCode === 0 && isHealthyStatus(code, health.expect)) {
			if (health.expect) {
				ctx.event("deploy.health_ok_expected", {
					code,
					expected: health.expect.join("/"),
				});
			} else {
				ctx.event("deploy.health_ok", { code });
			}
			return;
		}
		if (Date.now() > deadline) {
			throw commandError(
				"APP_HEALTH_FAILED",
				`HTTP ${result.stdout || result.stderr || "-"}`,
			);
		}
		await sleep(config.APP_HEALTH_INTERVAL_MS);
	}
}

export async function writeRoutes(
	executor: Executor,
	app: Pick<AppRow, "id" | "folder" | "templateId" | "customSpecEncrypted">,
	services: string[],
	appDomains: DomainRow[],
	values: Record<string, string>,
	ctx: JobContext,
	/** The server the routes are written on (its tunnel mode). */
	server: Pick<ServerRow, "tunnelOnly" | "tunnelEnabled">,
): Promise<void> {
	const target = appTraefikPath(app.id);
	if (appDomains.length === 0) {
		await run(
			executor,
			ctx,
			removeFileCommand(target),
			"APP_ROUTES_REMOVE_FAILED",
			{ quiet: true },
		);
		await setStatus(app.id, { routesPending: false });
		return;
	}
	const containerNames = Object.fromEntries(
		services.map((service) => [service, containerName(app.folder, service)]),
	);
	const config = getConfig();
	const manifest = await getAppManifest(app);
	const yaml = generateTraefikDynamic({
		appKey: traefikAppKey(app.id),
		routes: servedThroughTunnel(
			withRouteAuth(
				withPathRoutes(routesFromDomains(appDomains), manifest),
				manifest,
				values,
				bcryptHasher(config.TRAEFIK_BASIC_AUTH_COST),
			),
			new Set(
				appDomains
					.filter(
						(domain) =>
							server.tunnelOnly || (server.tunnelEnabled && domain.viaTunnel),
					)
					.map((domain) => domain.host),
			),
		),
		containerNames,
		certResolver: config.TRAEFIK_CERT_RESOLVER,
	});
	// 0600: may contain basic-auth hashes.
	await executor.upload(yaml, target, "0600");
	await setStatus(app.id, { routesPending: false });
	ctx.event("deploy.routes_updated", {
		hosts: { $list: appDomains.map((domain) => domain.host) },
	});
}

/**
 * Extra step run after images are pulled/built and before `up` (e.g. a
 * restore loading volumes and the database). Throwing fails the deploy.
 */
export type BeforeUpHook = (input: {
	executor: Executor;
	location: AppLocation;
	rendered: RenderedTemplate;
	app: AppRow;
}) => Promise<void>;

export async function runDeploy(
	appId: string,
	mode: DeployMode,
	version: string | undefined,
	ctx: JobContext,
	options: {
		beforeUp?: BeforeUpHook;
		/** Deploy on this server instead of the app's (a move's target). */
		server?: ServerRow;
		/** Owner-defined sources (git): what to deploy and whether to build. */
		source?: SourceRequest;
		/**
		 * Inside a bigger job (move, restore, cloud import): its cancel state
		 * stands until this deploy changes the server.
		 */
		nested?: boolean;
	} = {},
): Promise<JobOutcome> {
	const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	if (!app) return { success: false, error: new AppError("APP_NOT_FOUND") };
	const server = options.server ?? (await getAppServer(app));
	const location = appLocation(app);
	await setStatus(app.id, { status: "deploying", ...lastErrorColumns(null) });
	// Until the upload starts, a cancel leaves the server as it was.
	if (!options.nested) ctx.setCancelState?.("deploy_nothing_changed");

	let executor: Executor | null = null;
	// Until the rendered files are uploaded, the server (its files and
	// containers) is as it was: a failure keeps the app's status.
	let touched = false;
	try {
		// Containers are labelled with this instance's id (ownership).
		await requireInstanceId();
		ctx.event("deploy.rendering", {
			template: app.templateId,
			version: (mode === "update" ? version : app.version) ?? "",
		});
		executor = await getExecutor(server);
		await assertServerOwned(executor, await requireInstanceId());
		// No stored env: an earlier first deploy may have written its `.env`
		// (and initialised data with it) before failing; its generated
		// values are reused rather than generated again.
		const found = app.envEncrypted
			? null
			: await probeServerEnv(executor, location, ctx);
		const rendered = await renderApp(
			app,
			mode,
			version,
			server,
			options.source?.commitSha,
			found?.values ?? undefined,
		);
		if (found) {
			const recovered = Object.keys(
				carryOverValues(rendered.definitions, found.values ?? {}),
			).length;
			if (recovered > 0) {
				ctx.event("deploy.env_recovered", { count: recovered });
			} else {
				await warnNewSecretsOverData(
					executor,
					location,
					rendered,
					found.volumes,
					ctx,
				).catch((error) => logWarning(ctx, error));
			}
		}
		assertRenderedLimits(rendered, server);
		await db
			.update(deployments)
			.set({ commitSha: rendered.commitSha })
			.where(eq(deployments.id, ctx.deploymentId));
		const driver = await sourceDriver(
			await getTemplateManifest(app.templateId),
		);
		ctx.event("deploy.pinned", {
			version: rendered.version,
			commit: rendered.commitSha.slice(0, 12),
		});
		for (const warning of rendered.warnings) {
			ctx.event("job.warning", { warning: { $error: warning } });
		}

		const step = {
			executor,
			location,
			app,
			server,
			rendered,
			ctx,
			request: options.source ?? {},
		};
		// Before the files change: a failed build leaves the running app's
		// compose untouched.
		await driver.prepare?.(step);
		await persistRenderedEnv(app.id, rendered);
		touched = true;
		ctx.setCancelState?.("app_partly_updated");
		await uploadRendered(executor, location, rendered, ctx);
		await verifyResolvedCompose(executor, location, rendered, ctx);

		ctx.event("deploy.pulling");
		await withHeartbeat(
			getConfig().APP_PULL_HEARTBEAT_MS,
			(elapsed) =>
				ctx.event("deploy.pull_progress", { elapsed: { $ms: elapsed } }),
			() =>
				run(
					executor as Executor,
					ctx,
					composePrepareCommand(location, getConfig().APP_BUILD_RETRIES),
					"APP_PULL_FAILED",
				),
		);
		// Database links: their networks must exist before anything starts.
		await (await linksModule()).ensureLinkNetworks(
			executor,
			rendered.linkNetworks.map((name) => ({
				name,
				linkId: parseLinkNetworkName(name) ?? "",
			})),
			await requireInstanceId(),
			ctx,
		);
		// From here the app may initialise its data (or a restore loads it),
		// even if the deploy fails later: its initial_only values are frozen.
		await markInitialised(app, rendered.values);
		if (options.beforeUp) {
			await options.beforeUp({ executor, location, rendered, app });
		}
		// Which containers `up` recreates or (re)starts (BUG-023).
		const before = await readIdentities(executor, location, ctx);
		ctx.event("deploy.starting");
		const upStartedAt = Date.now();
		try {
			await run(executor, ctx, composeUpCommand(location), "COMPOSE_UP_FAILED");
		} catch (error) {
			// "A dependency is unhealthy" hides a memory limit that is too low.
			for (const hint of (
				await readOomHints(executor, location, ctx.signal, upStartedAt)
			).values()) {
				ctx.event("deploy.failure_hint", { hint: { $error: hint } });
			}
			throw error;
		}
		const after = before && (await readIdentities(executor, location, ctx));
		await recheckBindSources(executor, location, ctx, rendered.fileBinds);
		await (await linksModule()).pruneLinkNetworks(
			executor,
			server.id,
			await requireInstanceId(),
		);
		await writeRoutes(
			executor,
			app,
			rendered.services,
			await listAppDomains(app.id),
			rendered.values,
			ctx,
			server,
		);
		await waitUntilHealthy(executor, location, rendered, app, ctx, upStartedAt);

		// The new compose is live and ready: recorded before the dependents
		// step, which only restarts services of this same version.
		await setStatus(app.id, {
			status: "running",
			version: rendered.version,
			commitSha: rendered.commitSha,
			composeDeployed: rendered.compose,
			envEncrypted: encryptEnvValues(rendered.values),
			...deployedEnvColumns,
			// Merge into a fresh read: never write back the job-start snapshot.
			inputs: patchAppInputs(await freshApp(app.id), {
				templateKeys: Object.keys(rendered.definitions),
				// `up` started every service again.
				stoppedServices: undefined,
			}),
			needsRedeploy: false,
			...lastErrorColumns(null),
		});
		if (before && after) {
			await restartDependents(executor, location, rendered, app, ctx, {
				before,
				after,
				since: upStartedAt,
				model: rendered.composeModel,
			});
		}
		try {
			await driver.afterDeploy?.(step);
		} catch (error) {
			logWarning(ctx, error);
		}
		ctx.event("deploy.running", { app: app.name });
		recheckDomainsLater(app.id);
		return { success: true };
	} catch (error) {
		await setStatus(app.id, {
			status: touched ? "error" : untouchedStatus(app.status),
			...lastErrorColumns(error),
		});
		return { success: false, error, untouched: !touched };
	} finally {
		executor?.close();
	}
}

/**
 * The project's containers (id, start time, state) per service; null when
 * they cannot be read: the dependents are then left alone (a warning).
 */
async function readIdentities(
	executor: Executor,
	location: AppLocation,
	ctx: JobContext,
): Promise<ProjectIdentities | null> {
	try {
		return parseContainerIdentities(
			await run(
				executor,
				ctx,
				composeIdentityCommand(location),
				"COMPOSE_PS_FAILED",
				{ quiet: true },
			),
		);
	} catch (error) {
		logWarning(ctx, error);
		return null;
	}
}

/**
 * Once the app is ready, restart the running services that depend on one
 * `up` recreated or (re)started (they would keep their connections to the
 * old container, BUG-023), then wait until it is ready again. Templates
 * opt out with `restart_dependents = false`.
 */
async function restartDependents(
	executor: Executor,
	location: AppLocation,
	rendered: ReadinessTarget,
	app: AppRow,
	ctx: JobContext,
	input: {
		before: ProjectIdentities;
		after: ProjectIdentities;
		since: number;
		/** The compose model (`depends_on`). */
		model: unknown;
	},
): Promise<void> {
	if ((await getAppManifest(app)).restart_dependents === false) return;
	const { restart, changed } = dependentsToRestart({
		before: input.before,
		after: input.after,
		dependsOn: composeDependsOn(input.model, { runtimeOnly: true }),
	});
	if (restart.length === 0) return;
	ctx.event("deploy.restarting_dependents", {
		changed: { $list: changed },
		services: { $list: restart },
	});
	try {
		await run(
			executor,
			ctx,
			composeRestartServicesCommand(location, restart),
			"APP_RESTART_FAILED",
		);
	} catch (error) {
		// A warning: only the readiness below decides (a service that did
		// restart, or never stopped, may well be ready).
		logWarning(ctx, error);
	}
	// A second full wait (its own timeout): the restarted services start
	// from scratch, and the first wait's budget may be spent already.
	await waitUntilHealthy(executor, location, rendered, app, ctx, input.since);
}

/**
 * Status of an app whose deploy failed before it changed the server: a
 * settled status stays (its containers run as before); an app that was
 * never deployed (or mid-job) shows the failure.
 */
export function untouchedStatus(status: AppRow["status"]): AppRow["status"] {
	return status === "running" || status === "stopped" || status === "error"
		? status
		: "error";
}

/**
 * Re-render a deployed app's files on its server without restarting it
 * (database link changes: the networks file must stop listing a removed
 * link network, the links env file must go). The running containers keep
 * working; the next `up`/`start` uses the new files.
 */
export async function refreshAppFiles(
	executor: Executor,
	appId: string,
	ctx: JobContext,
): Promise<void> {
	const app = await freshApp(appId);
	if (!app.composeDeployed) return;
	// Never write under the root of a server another instance manages.
	await assertServerOwned(executor, await requireInstanceId());
	const rendered = await renderApp(
		app,
		"redeploy",
		undefined,
		await getAppServer(app),
	);
	await persistRenderedEnv(app.id, rendered);
	await uploadRendered(executor, appLocation(app), rendered, ctx);
	await setStatus(app.id, { composeDeployed: rendered.compose });
	ctx.event("deploy.files_refreshed", {
		app: app.name,
		count: rendered.linkNetworks.length,
	});
}

/** Log events and failure code of each service action. */
const serviceActionSteps = {
	start: {
		one: "app.starting_service",
		all: "app.starting_all",
		done: "app.started",
		failure: "APP_START_FAILED",
	},
	stop: {
		one: "app.stopping_service",
		all: "app.stopping_all",
		done: "app.stopped",
		failure: "APP_STOP_FAILED",
	},
	restart: {
		one: "app.restarting_service",
		all: "app.restarting_all",
		done: "app.restarted",
		failure: "APP_RESTART_FAILED",
	},
} as const satisfies Record<
	ServiceAction,
	{
		one: JobLogEvent;
		all: JobLogEvent;
		done: JobLogEvent;
		failure: DetailErrorCode;
	}
>;

async function runServiceAction(
	appId: string,
	action: ServiceAction,
	service: string | undefined,
	ctx: JobContext,
): Promise<JobOutcome> {
	const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	if (!app) return { success: false, error: new AppError("APP_NOT_FOUND") };
	const executor = await getExecutor(await getAppServer(app));
	const steps = serviceActionSteps[action];
	try {
		if (service) ctx.event(steps.one, { service });
		else ctx.event(steps.all);
		await run(
			executor,
			ctx,
			composeServiceCommand(appLocation(app), action, service),
			steps.failure,
		);
		const fresh = await freshApp(app.id);
		const stoppedServices = nextStoppedServices(
			appInputs(fresh).stoppedServices,
			action,
			service,
		);
		await setStatus(app.id, {
			...(service ? {} : { status: action === "stop" ? "stopped" : "running" }),
			inputs: patchAppInputs(fresh, { stoppedServices }),
		});
		ctx.event(steps.done);
		return { success: true };
	} catch (error) {
		return { success: false, error };
	} finally {
		executor.close();
	}
}

async function runRoutes(appId: string, ctx: JobContext): Promise<JobOutcome> {
	const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	if (!app) return { success: false, error: new AppError("APP_NOT_FOUND") };
	const services = deployedServices(app);
	if (services.length === 0) {
		// The first successful deploy writes the routes.
		await setStatus(app.id, { routesPending: false });
		ctx.event("routes.not_deployed");
		return { success: true };
	}
	const server = await getAppServer(app);
	const executor = await getExecutor(server);
	try {
		await assertServerOwned(executor, await requireInstanceId());
		await writeRoutes(
			executor,
			app,
			services,
			await listAppDomains(app.id),
			readEnvValues(app),
			ctx,
			server,
		);
		recheckDomainsLater(app.id);
		return { success: true };
	} catch (error) {
		return { success: false, error };
	} finally {
		executor.close();
	}
}

/**
 * Remove an app's routes and containers from one server (`executor`), and
 * with `wipeData` its volumes and folder. The app row is left alone (a
 * move tears down one copy and keeps the app).
 */
export async function teardownApp(
	executor: Executor,
	app: AppRow,
	options: { wipeData: boolean; removeImages: boolean },
	ctx: JobContext,
): Promise<void> {
	const { wipeData } = options;
	const location = appLocation(app);
	ctx.event("teardown.routes");
	await run(
		executor,
		ctx,
		removeFileCommand(appTraefikPath(app.id)),
		"APP_ROUTES_REMOVE_FAILED",
		{ quiet: true },
	);
	const images = options.removeImages
		? parseImageList(
				await run(
					executor,
					ctx,
					projectImagesCommand(location.folder),
					"APP_IMAGES_LIST_FAILED",
					{ quiet: true },
				),
			)
		: [];
	// Compose v2 finds the project's containers by label even without
	// the file, so orphans from partial deploys are removed too.
	ctx.event(wipeData ? "teardown.down_wipe" : "teardown.down");
	await run(
		executor,
		ctx,
		composeDownCommand(location, wipeData),
		"COMPOSE_DOWN_FAILED",
	);
	const removeImages = removeImagesScript(images);
	if (removeImages) {
		ctx.event("teardown.images");
		await run(executor, ctx, removeImages, "APP_IMAGES_REMOVE_FAILED");
	}
	const driver = await sourceDriver(await getTemplateManifest(app.templateId));
	await driver.teardown?.({
		executor,
		app,
		removeImages: options.removeImages || wipeData,
		ctx,
	});
	if (wipeData) {
		ctx.event("teardown.folder", { path: location.appRoot });
		await run(
			executor,
			ctx,
			removeAppFolderCommand(location),
			"APP_FOLDER_REMOVE_FAILED",
		);
	} else {
		ctx.event("teardown.kept", { path: location.appRoot });
	}
}

async function runDelete(
	appId: string,
	options: { wipeData: boolean; removeImages: boolean },
	ctx: JobContext,
): Promise<JobOutcome> {
	const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	if (!app) return { success: true };
	await setStatus(app.id, { status: "deleting" });
	const executor = await getExecutor(await getAppServer(app));
	try {
		// A database still in use is refused before the job starts; an app
		// using databases loses its links (and their networks) here.
		const { countDatabaseLinks, releaseAppLinks } = await linksModule();
		const links = await countDatabaseLinks(app.id);
		if (links > 0) {
			throw new AppError("DATABASE_HAS_LINKS", { count: links });
		}
		const databases = await releaseAppLinks(executor, app, ctx);
		await teardownApp(executor, app, options, ctx);
		await db.delete(apps).where(eq(apps.id, app.id));
		// The link rows went with the app: the databases' files stop naming
		// the removed networks.
		for (const databaseId of databases) {
			await refreshAppFiles(executor, databaseId, ctx).catch((error) =>
				logWarning(ctx, error),
			);
		}
		ctx.event("app.deleted", { app: app.name });
		return { success: true };
	} catch (error) {
		await setStatus(app.id, { status: "error", ...lastErrorColumns(error) });
		return { success: false, error };
	} finally {
		executor.close();
	}
}

// ---------------------------------------------------------------------------
// Entry points used by server functions.

export function startAppJob(
	app: AppRow,
	actor: Actor,
	type: string,
	title: JobTitle,
	runJob: (ctx: JobContext) => Promise<JobOutcome>,
) {
	return startJob(
		{ actor, serverId: app.serverId, appId: app.id, type, title },
		runJob,
	);
}

export async function createAndDeployApp(
	actor: Actor,
	input: CreateAppInput,
	/** Initial resource limit overrides (e.g. a new database's memory). */
	extra: { resources?: AppInputs["resources"] } = {},
): Promise<{ appId: string; deploymentId: string }> {
	// Rendered before the row exists: a refused version or input fails the
	// request instead of leaving an app in ERROR.
	const app = await createAppRecord(actor, input, {
		...extra,
		dryRender: true,
	});
	audit({ actor, action: "app.create", targetType: "app", targetId: app.id });
	if (await isGitApp(app)) {
		// The first deploy builds the branch tip.
		const { startBuildAndDeploy } = await import(
			"#/features/git/git.server.ts"
		);
		const { deploymentId } = await startBuildAndDeploy(actor, app, {
			trigger: "create",
		});
		return { appId: app.id, deploymentId };
	}
	const { deploymentId } = await startAppJob(
		app,
		actor,
		"app_deploy",
		jobTitle("app_deploy", { app: app.name }),
		(ctx) => runDeploy(app.id, "deploy", undefined, ctx),
	);
	return { appId: app.id, deploymentId };
}

export async function startAppAction(
	actor: Actor,
	input:
		| { appId: string; action: "redeploy" }
		| { appId: string; action: "routes" }
		| { appId: string; action: ServiceAction; service?: string }
		| {
				appId: string;
				action: "update";
				version: string;
				backupFirst?: boolean;
				/** The owner ticked "I understand" for an older version. */
				confirmDowngrade?: boolean;
		  },
): Promise<{ deploymentId: string }> {
	const app = await getAppRow(actor, input.appId);
	// Server-computed: the audit never trusts the request's own claim.
	let downgrade: DowngradeRisk | null = null;
	if (input.action === "update") {
		// Before the audit entry: a refused downgrade changes nothing.
		const manifest = await assertVersioned(app);
		downgrade = versionChangeRisk(app, input.version, manifest);
		if (downgrade && !input.confirmDowngrade) {
			throw new AppError("APP_DOWNGRADE_UNCONFIRMED", {
				from: app.version,
				to: input.version,
			});
		}
	}
	audit({
		actor,
		action: `app.${input.action}`,
		targetType: "app",
		targetId: app.id,
		meta:
			"service" in input && input.service
				? { service: input.service }
				: input.action === "update" && downgrade
					? {
							from: app.version,
							to: input.version,
							downgrade: true,
							risk: downgrade,
						}
					: undefined,
	});
	if (input.action === "redeploy") {
		if (!app.commitSha && (await isGitApp(app))) {
			// Never built: a redeploy builds the branch tip.
			const { startBuildAndDeploy } = await import(
				"#/features/git/git.server.ts"
			);
			return startBuildAndDeploy(actor, app, { trigger: "manual" });
		}
		const mode: DeployMode = app.commitSha ? "redeploy" : "deploy";
		return startAppJob(
			app,
			actor,
			"app_redeploy",
			jobTitle("app_redeploy", { app: app.name }),
			(ctx) => runDeploy(app.id, mode, undefined, ctx),
		);
	}
	if (input.action === "routes") {
		return startRoutesJob(actor, app);
	}
	if (input.action === "update") {
		const first = input.backupFirst ? await backupFirstStep(actor, app) : null;
		return startAppJob(
			app,
			actor,
			"app_update",
			jobTitle("app_update", { app: app.name, version: input.version }),
			async (ctx) => {
				await first?.(ctx);
				return runDeploy(app.id, "update", input.version, ctx);
			},
		);
	}
	const service = input.service;
	if (service) {
		assertServiceName(service);
		if (!deployedServices(app).includes(service)) {
			throw new AppError("APP_SERVICE_NOT_FOUND", { service });
		}
	}
	return startAppJob(
		app,
		actor,
		`app_${input.action}`,
		service
			? jobTitle(`app_${input.action}_service`, { app: app.name, service })
			: jobTitle(`app_${input.action}`, { app: app.name }),
		(ctx) =>
			runServiceAction(app.id, input.action as ServiceAction, service, ctx),
	);
}

export async function startRoutesJob(
	actor: Actor,
	app: AppRow,
): Promise<{ deploymentId: string }> {
	return startAppJob(
		app,
		actor,
		"app_routes",
		jobTitle("app_routes", { app: app.name }),
		(ctx) => runRoutes(app.id, ctx),
	);
}

export async function deleteApp(
	actor: Actor,
	input: {
		appId: string;
		confirmName: string;
		wipeData: boolean;
		removeImages: boolean;
		backupFirst?: boolean;
	},
): Promise<{ deploymentId: string }> {
	const app = await getAppRow(actor, input.appId);
	assertDeleteConfirmation(app, input.confirmName);
	const links = await (await linksModule()).countDatabaseLinks(app.id);
	if (links > 0) throw new AppError("DATABASE_HAS_LINKS", { count: links });
	const first = input.backupFirst ? await backupFirstStep(actor, app) : null;
	audit({
		actor,
		action: "app.delete",
		targetType: "app",
		targetId: app.id,
		meta: { wipeData: input.wipeData, removeImages: input.removeImages },
	});
	return startAppJob(
		app,
		actor,
		"app_delete",
		jobTitle("app_delete", { app: app.name }),
		async (ctx) => {
			await first?.(ctx);
			return runDelete(app.id, input, ctx);
		},
	);
}

/** Diff the deployed compose/env against `version` without touching the server. */
export async function previewAppUpdate(
	actor: Actor,
	appId: string,
	version: string,
): Promise<AppUpdatePreview> {
	const app = await getAppRow(actor, appId);
	const manifest = await assertVersioned(app);
	const rendered = await renderApp(app, "update", version);
	const composeLines = diffLines(app.composeDeployed ?? "", rendered.compose);
	const downgrade = versionChangeRisk(app, version, manifest);
	const params = { from: app.version, to: version };
	return {
		version: rendered.version,
		commitSha: rendered.commitSha,
		composeDiff: formatUnifiedDiff(composeLines),
		composeChanged: composeLines.some((line) => line.kind !== "same"),
		env: diffEnvKeys(deployedEnvValues(app), rendered.values),
		downgrade,
		// The downgrade comes first: it matters more than render notes.
		warnings: [
			...(downgrade === "irreversible"
				? [coded("APP_DOWNGRADE_WARN_IRREVERSIBLE", params)]
				: downgrade
					? [coded("APP_DOWNGRADE_WARN", params)]
					: []),
			...rendered.warnings,
		],
	};
}

// ---------------------------------------------------------------------------
// Rotation of generated variables (template `rotatable = true`)

/**
 * Regenerate a rotatable variable and everything derived from it (e.g. JWTs
 * signed with a rotated secret), then redeploy so every service picks it up.
 */
export async function rotateAppVariable(
	actor: Actor,
	appId: string,
	name: string,
	options: { backupFirst?: boolean; runRotateHook?: boolean } = {},
): Promise<{ deploymentId: string }> {
	const app = await getAppRow(actor, appId);
	const manifest = await getAppManifest(app);
	const variable = manifest.variables[name];
	if (!variable?.rotatable) {
		throw new AppError("VARIABLE_NOT_ROTATABLE", { name });
	}
	const hook = variable.on_rotate;
	const runHook = hook ? (options.runRotateHook ?? hook.default) : null;
	const first = options.backupFirst ? await backupFirstStep(actor, app) : null;
	const mode: DeployMode = app.commitSha ? "redeploy" : "deploy";
	return startAppJob(
		app,
		actor,
		"app_redeploy",
		jobTitle("app_rotate", { name }),
		async (ctx) => {
			// Back up while the old value is still the stored one.
			await first?.(ctx);
			await dropRotatedValues(actor, app.id, name, runHook);
			ctx.event("app.rotating", { name });
			return deployThenRotateHook(ctx, name, runHook, {
				deploy: () => runDeploy(app.id, mode, undefined, ctx),
				hook: hook ? () => runRotateHook(actor, app.id, name, hook, ctx) : null,
			});
		},
	);
}

/**
 * Redeploy, then the template's `on_rotate` step when requested: only
 * once every service runs with the new value (a failed deploy leaves e.g.
 * sessions alone; the owner retries the rotation). The step never changes
 * the job's outcome.
 */
export async function deployThenRotateHook(
	ctx: Pick<JobContext, "event">,
	name: string,
	runHook: boolean | null,
	steps: {
		deploy: () => Promise<JobOutcome>;
		hook: (() => Promise<unknown>) | null;
	},
): Promise<JobOutcome> {
	const outcome = await steps.deploy();
	if (outcome.success && steps.hook) {
		if (runHook) await steps.hook();
		else ctx.event("app.rotate_hook_skipped", { name });
	}
	return outcome;
}

/**
 * A variable's template `on_rotate` step (SQL through psql in the
 * service's container). Never fails the job: the rotation itself is done,
 * so a failure is a coded warning (counted in the job's summary) and the
 * app remembers it (`inputs.rotateHookFailed`): the overview offers to
 * run the step again. SQL and output stay out of the log (psql's error
 * goes to the warning's details only).
 */
export async function runRotateHook(
	actor: Actor,
	appId: string,
	name: string,
	hook: TemplateRotateHook,
	ctx: JobContext,
	options: { rerun?: boolean } = {},
): Promise<boolean> {
	const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	if (!app) return false;
	const finish = async (error: AppError | null): Promise<boolean> => {
		const ok = error === null;
		audit({
			actor,
			action: "app.variable.rotate_hook",
			targetType: "app",
			targetId: app.id,
			meta: { name, service: hook.service, ok, rerun: !!options.rerun },
		});
		if (error) {
			logWarning(ctx, error);
			await ctx.addWarnings?.(1);
		}
		const [current] = await db
			.select()
			.from(apps)
			.where(eq(apps.id, appId))
			.limit(1);
		const failed = new Set(appInputs(current ?? app).rotateHookFailed ?? []);
		if (ok) failed.delete(name);
		else failed.add(name);
		await setStatus(app.id, {
			inputs: patchAppInputs(current ?? app, {
				rotateHookFailed: failed.size ? [...failed] : undefined,
			}),
		});
		return ok;
	};
	if (!deployedServices(app).includes(hook.service)) {
		return finish(
			new AppError("APP_ROTATE_HOOK_SERVICE_MISSING", {
				name,
				service: hook.service,
			}),
		);
	}
	ctx.event("app.rotate_hook_running", { name, service: hook.service });
	const config = getConfig();
	const executor = await getExecutor(await getAppServer(app));
	try {
		const result = await executor.exec(
			psqlCommand(
				{
					container: containerName(app.folder, hook.service),
					user: hook.user,
					database: hook.database,
					timeoutMs: config.APP_ROTATE_HOOK_TIMEOUT_MS,
				},
				true,
			),
			{
				input: hook.sql,
				timeoutMs:
					config.APP_ROTATE_HOOK_TIMEOUT_MS + config.APP_ROTATE_HOOK_SLACK_MS,
				signal: ctx.signal,
			},
		);
		if (result.exitCode !== 0) {
			throw new AppError("APP_ROTATE_HOOK_FAILED", {
				name,
				service: hook.service,
				detail: formatPsqlError(result.stderr || result.stdout),
			});
		}
		ctx.event("app.rotate_hook_done", { name });
		return await finish(null);
	} catch (error) {
		return await finish(
			error instanceof AppError
				? error
				: new AppError("APP_ROTATE_HOOK_FAILED", {
						name,
						service: hook.service,
						detail: error instanceof Error ? error.message : String(error),
					}),
		);
	} finally {
		executor.close();
	}
}

/**
 * Run a rotated variable's `on_rotate` step again (after it failed or
 * could not run), without rotating anything. Audited by the step itself.
 */
export async function rerunRotateHook(
	actor: Actor,
	appId: string,
	name: string,
): Promise<{ deploymentId: string }> {
	const app = await getAppRow(actor, appId);
	const manifest = await getAppManifest(app);
	const hook = manifest.variables[name]?.on_rotate;
	if (!hook || !appInputs(app).rotateHookFailed?.includes(name)) {
		throw new AppError("APP_ROTATE_HOOK_NOT_PENDING", { name });
	}
	return startAppJob(
		app,
		actor,
		"app_rotate_hook",
		jobTitle("app_rotate_hook", { name }),
		async (ctx) => {
			await runRotateHook(actor, app.id, name, hook, ctx, { rerun: true });
			// A failed step is a warning of the job, like after a rotation.
			return { success: true };
		},
	);
}

/**
 * Record the `AppInputs.initialised` marker the first time a deploy
 * reaches `compose up`: the initial_only variables of `values` (the env
 * the app starts with). Later deploys keep it.
 */
async function markInitialised(
	app: AppRow,
	values: Record<string, string>,
): Promise<void> {
	const fresh = await freshApp(app.id);
	if (appInputs(fresh).initialised) return;
	const manifest = await getAppManifest(fresh);
	await setStatus(app.id, {
		inputs: patchAppInputs(fresh, {
			initialised: initialisedNames(manifest.variables, values),
		}),
	});
}

/**
 * Drop a rotatable value and everything derived from it so the next render
 * regenerates them, except frozen initial_only values (the app ignores a
 * new one). Runs inside the job (server lock held).
 */
async function dropRotatedValues(
	actor: Actor,
	appId: string,
	name: string,
	rotateHook: boolean | null,
): Promise<void> {
	const app = await getAppRow(actor, appId);
	const manifest = await getAppManifest(app);
	const definitions = Object.fromEntries(
		Object.entries(manifest.variables).map(([key, variable]) => [
			key,
			variable.value,
		]),
	);
	const drop = rotationDrops(
		definitions,
		name,
		frozenInitialValues(manifest.variables, appInitialised(app)),
	);
	const values = Object.fromEntries(
		Object.entries(readEnvValues(app)).filter(([key]) => !drop.has(key)),
	);
	const overrides = Object.fromEntries(
		Object.entries(appOverrides(app)).filter(([key]) => !drop.has(key)),
	);
	await setStatus(app.id, {
		envEncrypted: app.envEncrypted ? encryptEnvValues(values) : null,
		inputs: patchAppInputs(app, { overrides }),
		needsRedeploy: true,
	});
	audit({
		actor,
		action: "app.variable.rotate",
		targetType: "app",
		targetId: app.id,
		// rotateHook: the template's follow-up step was requested (null: none).
		meta: { name, regenerated: [...drop], rotateHook },
	});
}

// ---------------------------------------------------------------------------
// Service-scoped secret env (template `service_env`)

/**
 * The readiness target of the deployed app (no render): its domains'
 * routes, primary first, and its services' container names.
 */
async function deployedReadinessTarget(app: AppRow): Promise<ReadinessTarget> {
	return {
		routes: routesFromDomains(await listAppDomains(app.id)),
		containerNames: Object.fromEntries(
			deployedServices(app).map((service) => [
				service,
				containerName(app.folder, service),
			]),
		),
	};
}

/** Write a service's env file, recreate it (exported for tests). */
export async function runApplyServiceEnv(
	appId: string,
	service: string,
	ctx: JobContext,
): Promise<JobOutcome> {
	const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	if (!app) return { success: false, error: new AppError("APP_NOT_FOUND") };
	const location = appLocation(app);
	const executor = await getExecutor(await getAppServer(app));
	try {
		ctx.event("app.writing_env", { file: serviceEnvFile(service) });
		await executor.upload(
			renderEnvFile(readServiceEnv(app)[service] ?? {}),
			`${location.appRoot}/${serviceEnvFile(service)}`,
			"0600",
		);
		const before = await readIdentities(executor, location, ctx);
		ctx.event("app.recreating", { service });
		const recreatedAt = Date.now();
		const result = await executor.exec(
			composeRecreateServiceCommand(location, service),
			{
				signal: ctx.signal,
				onStdout: (chunk) => ctx.log(chunk),
				onStderr: (chunk) => ctx.log(chunk),
			},
		);
		if (result.exitCode !== 0) {
			throw new AppError("APP_SERVICE_RECREATE_FAILED", {
				service,
				detail: result.stderr || result.stdout || `exit ${result.exitCode}`,
			});
		}
		const after = before && (await readIdentities(executor, location, ctx));
		// Success only once the recreated service (and what depends on it,
		// restarted like after a deploy, BUG-023) is ready again.
		const target = await deployedReadinessTarget(app);
		await waitUntilHealthy(executor, location, target, app, ctx, recreatedAt);
		if (before && after) {
			await restartDependents(executor, location, target, app, ctx, {
				before,
				after,
				since: recreatedAt,
				model: app.composeDeployed ? parseYaml(app.composeDeployed) : {},
			});
		}
		ctx.event("app.env_updated", { service });
		return { success: true };
	} catch (error) {
		return { success: false, error };
	} finally {
		executor.close();
	}
}

/**
 * Store set/remove edits (encrypted) and, when the deployed compose already
 * reads the service's env file, recreate the service. Otherwise the app is
 * flagged for a redeploy.
 */
export async function updateServiceEnv(
	actor: Actor,
	input: {
		appId: string;
		service: string;
		set: Record<string, string>;
		remove: string[];
	},
): Promise<{ deploymentId: string | null }> {
	const owned = await getAppRow(actor, input.appId);
	await assertServiceEnvService(owned, input.service);
	const applied = await withAppServerLock(owned, async () => {
		const app = await getAppRow(actor, input.appId);
		const all = readServiceEnv(app);
		// Input problems throw coded TemplateErrors.
		const next = editServiceEnv(all[input.service] ?? {}, input, {
			reserved: composeEnvironmentNames(app, input.service),
			maxVars: getConfig().APP_SERVICE_ENV_MAX_VARS,
		});
		const deployed = isServiceEnvDeployed(app, input.service);
		await setStatus(app.id, {
			serviceEnvEncrypted: encryptServiceEnv({ ...all, [input.service]: next }),
			...(deployed ? {} : { needsRedeploy: true }),
		});
		audit({
			actor,
			action: "app.service_env.update",
			targetType: "app",
			targetId: app.id,
			meta: {
				service: input.service,
				set: Object.keys(input.set),
				removed: input.remove,
			},
		});
		return deployed;
	});
	if (!applied || !deployedServices(owned).includes(input.service)) {
		return { deploymentId: null };
	}
	return startAppJob(
		owned,
		actor,
		"app_restart",
		jobTitle("app_service_env", { service: input.service }),
		(ctx) => runApplyServiceEnv(owned.id, input.service, ctx),
	);
}

/**
 * Who may cancel a job: app jobs go through the app row with app.deploy (a
 * database's jobs need database.manage); server jobs (bootstrap,
 * sweeps...) need server.manage.
 */
export async function assertCanCancelJob(
	actor: Actor,
	job: { appId: string | null },
): Promise<void> {
	if (job.appId) await getAppRow(actor, job.appId, "app.deploy");
	else assertCanAccess(actor, "server.manage");
}
