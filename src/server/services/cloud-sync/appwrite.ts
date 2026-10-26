import { randomUUID } from "node:crypto";
import type {
	AppwriteConnectionConfig,
	CloudSyncProvider,
	SyncDirection,
	SyncPart,
} from "#/config/cloud-sync.ts";
import { resourceName } from "#/config/identifiers.ts";
import { getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import type { CloudConnectionTestRecord } from "#/db/schema/cloud-sync.ts";
import {
	type AppwritePluginConfig,
	AppwritePluginConfigSchema,
} from "#/features/appwrite/schema.ts";
import { asList, type ErrorInfo } from "#/libs/coded.ts";
import { clip } from "#/libs/format.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import {
	curlConfig,
	type GatewayRequest,
	type GatewayResponse,
	gatewayCommand,
	parseGatewayResponse,
} from "#/server/services/gateway.ts";
import { AppError, coded, internalError } from "#/utils/error.ts";
import {
	type AppwriteApi,
	type AppwriteSourceCounts,
	appwriteApi,
	appwriteCloud,
	countSource,
	isRefused,
	SCOPE_PROBES,
} from "./appwrite-api";
import {
	exportOptions,
	exportPreflight,
	isExportRecovery,
	openExport,
	recoverExport,
} from "./appwrite-export";
import {
	compareMigration,
	consoleSignInError,
	type LocalRequest,
	localRequests,
	type MigrationStatus,
	migrationError,
	migrationProgress,
	migrationResources,
	parseMigration,
	progressKey,
	sessionCookie,
} from "./appwrite-local";
import { analyzeAppwritePreflight } from "./appwrite-preflight";
import { errorDetail, pinnedHost } from "./http";
import type {
	CloudPreflight,
	CloudSyncDriver,
	ExportSource,
	OpenedSync,
	PreflightContent,
	SyncRun,
	SyncStep,
	SyncTarget,
	TemplateProbe,
} from "./types";

/**
 * Appwrite driver: an Appwrite Cloud project → a new self-hosted Appwrite
 * app, through Appwrite's own Migrations (the destination pulls from the
 * source over its REST API; nothing is dumped by the panel):
 * - before the job, the panel reads the cloud project (version, counts)
 *   with its API key through the pinned client;
 * - the job deploys the app, creates the console admin (the member's
 *   email, the template's generated password), an organization, a project
 *   with the cloud's project ID and a temporary key, then starts
 *   `POST /v1/migrations/appwrite` on that project and follows it;
 * - the key and the console session are removed whatever happens.
 * Requests to the new app go through a throwaway curl container on the
 * proxy network (#/server/services/gateway.ts): credentials on stdin.
 */

type Config = AppwriteConnectionConfig;

export const parse = (
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
) => provider.schema.parse(raw) as Config;

/** Allowlisted endpoint host (checked before any request is sent). */
export async function checkEndpoint(
	provider: CloudSyncProvider,
	config: Config,
) {
	await pinnedHost(provider, new URL(config.endpoint).hostname);
}

/** Region of a Cloud endpoint (`fra.cloud.appwrite.io` → `fra`). */
export function endpointRegion(endpoint: string): string {
	const host = new URL(endpoint).hostname;
	const [first, ...rest] = host.split(".");
	return rest.length > 2 && first && /^[a-z]+$/.test(first) ? first : "";
}

export function pluginConfig(raw: unknown): AppwritePluginConfig {
	const parsed = AppwritePluginConfigSchema.safeParse(raw);
	if (!parsed.success) {
		throw new AppError("APPWRITE_PLUGIN_CONFIG_INVALID", {
			detail: parsed.error.message,
		});
	}
	return parsed.data;
}

async function test(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
): Promise<Omit<CloudConnectionTestRecord, "at">> {
	const config = parse(provider, raw);
	const api = appwriteApi(provider, config);
	const steps: CloudConnectionTestRecord["steps"] = [];
	const info: Record<string, string> = { project: config.projectId };
	const warnings: ErrorInfo[] = [];
	let reachable = false;
	try {
		await checkEndpoint(provider, config);
		info.version = await api.version();
		reachable = true;
		steps.push({ step: "version", ok: true });
	} catch (error) {
		steps.push({ step: "version", ok: false, error: errorInfoOf(error) });
	}
	const missing: string[] = [];
	let keyError: unknown = null;
	let readable = 0;
	if (reachable) {
		for (const probe of SCOPE_PROBES) {
			try {
				const page = await api.list(probe.path, probe.key);
				if (probe.resource !== "teams") {
					info[probe.resource] = String(page.total);
				}
				readable++;
			} catch (error) {
				if (!isRefused(error)) {
					keyError ??= error;
					continue;
				}
				missing.push(probe.resource);
				keyError ??= error;
			}
		}
	}
	if (!reachable) {
		steps.push({ step: "key", ok: true, skipped: true });
		steps.push({ step: "scopes", ok: true, skipped: true });
	} else if (readable === 0) {
		// Nothing readable: a wrong key or project ID, not missing scopes.
		steps.push({
			step: "key",
			ok: false,
			error: errorInfoOf(keyError),
		});
		steps.push({ step: "scopes", ok: true, skipped: true });
	} else {
		steps.push({ step: "key", ok: true });
		if (missing.length > 0) {
			info.missing = missing.join(", ");
			steps.push({
				step: "scopes",
				ok: false,
				error: coded("CLOUD_APPWRITE_SCOPES_MISSING", {
					resources: asList(missing),
				}),
			});
		} else if (keyError) {
			steps.push({ step: "scopes", ok: false, error: errorInfoOf(keyError) });
		} else {
			steps.push({ step: "scopes", ok: true });
		}
	}
	const ok = steps.every((step) => step.ok);
	const failed = steps.find((step) => !step.ok)?.error ?? null;
	let exportReason: ErrorInfo | null = failed;
	if (ok) {
		// Export also starts migrations on the cloud (`migrations.write`).
		try {
			const plugin = await templatePlugin(provider);
			if (!(await appwriteCloud(provider, config).canStartMigrations())) {
				exportReason = coded("CLOUD_EXPORT_KEY_NO_WRITE", {
					scopes: asList(plugin.sync_cloud_key_scopes),
				});
			}
		} catch (error) {
			exportReason = errorInfoOf(error);
		}
	}
	return {
		ok,
		steps,
		info,
		warnings,
		directions: [
			{ direction: "import", ok, reason: failed },
			{ direction: "export", ok: exportReason === null, reason: exportReason },
		],
	};
}

/** The release the new app deploys (compared with the cloud's version). */
async function targetVersion(probe: TemplateProbe): Promise<string | null> {
	return probe.version;
}

/** Preflight rows of the selected parts, from the cloud's counts. */
export function previewContents(
	plugin: AppwritePluginConfig,
	parts: SyncPart[],
	counts: AppwriteSourceCounts,
): PreflightContent[] {
	const count = (
		resource: string,
		unit: PreflightContent["counts"][0]["unit"],
	) => {
		const found = counts.resources[resource];
		return found
			? [
					{
						unit,
						count: found.count,
						...(found.atLeast ? { atLeast: true } : {}),
					},
				]
			: [];
	};
	const rows: PreflightContent[] = [];
	for (const part of parts) {
		const resources = plugin.sync_resources[part] ?? [];
		const has = (resource: string) => resources.includes(resource);
		const row: PreflightContent = { part, sizeBytes: null, counts: [] };
		if (has("user")) row.counts.push(...count("user", "users"));
		if (has("team")) row.counts.push(...count("team", "teams"));
		if (has("membership"))
			row.counts.push(...count("membership", "memberships"));
		if (has("database")) row.counts.push(...count("database", "databases"));
		if (has("table")) row.counts.push(...count("table", "tables"));
		if (has("row")) row.counts.push(...count("row", "rows"));
		if (has("bucket")) row.counts.push(...count("bucket", "buckets"));
		if (has("file")) {
			row.counts.push(...count("file", "files"));
			row.sizeBytes = counts.fileBytes;
		}
		if (has("function")) {
			row.counts.push(...count("function", "functions"));
			row.names = counts.functionNames;
		}
		if (has("platform")) row.counts.push(...count("platform", "platforms"));
		rows.push(row);
	}
	return rows;
}

async function preflight(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
	input: Parameters<CloudSyncDriver["preflight"]>[2],
): Promise<CloudPreflight> {
	if (input.direction === "export") {
		if (!input.source) throw internalError("Export preflight without its app");
		return exportPreflight(provider, raw, input, input.source);
	}
	const config = parse(provider, raw);
	await checkEndpoint(provider, config);
	const api = appwriteApi(provider, config);
	const settings = await templatePlugin(provider);
	const version = await api.version();
	const name = (await api.projectName()) ?? config.projectId;
	const counts = await countSource(
		api,
		migrationResources(settings, input.parts),
	);
	const functionCount = counts.resources.function?.count ?? 0;
	const analysis = analyzeAppwritePreflight({
		projectId: config.projectId,
		sourceVersion: version,
		targetVersion: input.target.version,
		copyBytes: counts.fileBytes ?? 0,
		freeDiskBytes: input.target.freeDiskBytes,
		diskFactor: getConfig().CLOUD_SYNC_DISK_FACTOR,
		functionCount,
		refused: counts.refused,
		partial: counts.partial,
		wantsFunctions: migrationResources(settings, input.parts).includes(
			"function",
		),
	});
	return {
		project: {
			id: config.projectId,
			name,
			region: endpointRegion(config.endpoint),
			status: "",
		},
		versions: { source: version, target: input.target.version },
		target: input.target,
		contents: previewContents(settings, input.parts, counts),
		...analysis,
	};
}

/** The Appwrite template's `[plugin]` config (resources per part). */
async function templatePlugin(
	provider: CloudSyncProvider,
): Promise<AppwritePluginConfig> {
	const { getTemplateManifest } = await import(
		"#/features/templates/templates.server.ts"
	);
	return pluginConfig((await getTemplateManifest(provider.templateId)).plugin);
}

function importInputs(input: {
	pluginConfig: unknown;
	email: string | null;
}): Record<string, string> {
	const plugin = pluginConfig(input.pluginConfig);
	if (!input.email) throw new AppError("CLOUD_SYNC_EMAIL_MISSING");
	return { [plugin.console_email]: input.email };
}

// ---------------------------------------------------------------------------
// The job: bootstrap the new app's console, then Appwrite's migration.

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

/** Requests to the new app's API (throwaway curl container, stdin config). */
export function localClient(target: SyncTarget, plugin: AppwritePluginConfig) {
	const config = getConfig();
	const send = async (
		request: LocalRequest,
	): Promise<GatewayResponse & { json: unknown }> => {
		const gateway: GatewayRequest = {
			network: config.NITROBASE_NETWORK,
			image: config.APP_HEALTH_IMAGE,
			container: target.container(plugin.api_service),
			port: plugin.api_port,
			path: `${plugin.api_path}${request.path}`,
			query: request.query,
			method: request.method,
			headers: request.headers,
			body:
				request.body !== undefined ? JSON.stringify(request.body) : undefined,
			timeoutMs: config.CLOUD_SYNC_APPWRITE_HTTP_TIMEOUT_MS,
			maxResponseBytes: config.CLOUD_SYNC_APPWRITE_MAX_RESPONSE_BYTES,
		};
		const stdout = await target.run(
			gatewayCommand(gateway),
			(detail) => new AppError("APPWRITE_API_NOT_READY", { detail }),
			{ input: curlConfig(gateway), quiet: true },
		);
		const response = parseGatewayResponse(
			stdout,
			"",
			config.CLOUD_SYNC_APPWRITE_MAX_RESPONSE_BYTES,
		);
		let json: unknown = null;
		try {
			json = response.body ? JSON.parse(response.body) : null;
		} catch {
			json = null;
		}
		return { ...response, json };
	};
	/** Send; anything but `ok` statuses is a coded error (body as detail). */
	const expect = async (request: LocalRequest, ok: number[] = [200, 201]) => {
		const response = await send(request);
		if (response.status === null || !ok.includes(response.status)) {
			throw new AppError("APPWRITE_REQUEST_FAILED", {
				action: `${request.method} ${plugin.api_path}${request.path}`,
				status: response.status ?? 0,
				detail: clip(response.body, TEXT_LIMITS.errorDetail),
			});
		}
		return response;
	};
	return { send, expect };
}

interface JobState {
	secrets: string[];
	counts: AppwriteSourceCounts | null;
}

/** Wait until the new app's API answers (it was just deployed). */
async function waitReady(
	client: ReturnType<typeof localClient>,
	plugin: AppwritePluginConfig,
	signal?: AbortSignal,
) {
	const config = getConfig();
	const deadline = Date.now() + config.CLOUD_SYNC_APPWRITE_READY_TIMEOUT_MS;
	let last = "";
	for (;;) {
		if (signal?.aborted) throw new AppError("JOB_CANCELLED");
		try {
			const response = await client.send(localRequests.health(plugin));
			if (response.status === 200) return;
			last = `HTTP ${response.status ?? 0}`;
		} catch (error) {
			last = errorDetail(error);
		}
		if (Date.now() > deadline) {
			throw new AppError("APPWRITE_API_NOT_READY", { detail: last });
		}
		await sleep(config.CLOUD_SYNC_APPWRITE_POLL_MS, signal);
	}
}

/**
 * Follow a migration until it completes or fails. Bounded: `pending`
 * (no worker took it), no progress while `processing`, and the job timeout.
 */
export async function follow(
	run: SyncRun,
	read: () => Promise<MigrationStatus>,
): Promise<MigrationStatus> {
	const config = getConfig();
	const started = Date.now();
	const deadline = started + config.CLOUD_SYNC_JOB_TIMEOUT_MS;
	let reported = "";
	let changedAt = started;
	const minutes = (ms: number) => Math.round(ms / 60_000);
	for (;;) {
		if (run.job.signal?.aborted) throw new AppError("JOB_CANCELLED");
		const status = await read();
		if (status.status === "completed" || status.status === "failed") {
			return status;
		}
		const now = Date.now();
		const key = progressKey(status);
		if (key !== reported) {
			reported = key;
			changedAt = now;
			const progress = migrationProgress(status);
			run.job.event("appwrite_sync.migration_progress", {
				migration_stage: status.stage,
				done: progress.done,
				total: progress.total,
			});
		}
		if (
			status.status === "pending" &&
			now - started > config.CLOUD_SYNC_APPWRITE_PENDING_TIMEOUT_MS
		) {
			throw new AppError("APPWRITE_MIGRATION_STUCK", {
				minutes: minutes(config.CLOUD_SYNC_APPWRITE_PENDING_TIMEOUT_MS),
			});
		}
		if (
			status.status !== "pending" &&
			now - changedAt > config.CLOUD_SYNC_APPWRITE_STALL_TIMEOUT_MS
		) {
			throw new AppError("APPWRITE_MIGRATION_STALLED", {
				minutes: minutes(config.CLOUD_SYNC_APPWRITE_STALL_TIMEOUT_MS),
			});
		}
		if (now > deadline) {
			throw new AppError("APPWRITE_MIGRATION_TIMEOUT", {
				minutes: minutes(config.CLOUD_SYNC_JOB_TIMEOUT_MS),
			});
		}
		await sleep(config.CLOUD_SYNC_APPWRITE_POLL_MS, run.job.signal);
	}
}

/** What a crash recovery needs to clean up (ids only, never secrets). */
interface AppwriteRecoveryState {
	projectId: string;
	keyId: string | null;
	migrationId: string | null;
}

function isRecoveryState(value: unknown): value is AppwriteRecoveryState {
	const state = value as Partial<AppwriteRecoveryState> | null;
	return (
		!!state &&
		typeof state.projectId === "string" &&
		(state.keyId === null || typeof state.keyId === "string") &&
		(state.migrationId === null || typeof state.migrationId === "string")
	);
}

/** The console admin login of the new app (from its variables). */
export function consoleLogin(target: SyncTarget, plugin: AppwritePluginConfig) {
	const email = target.values[plugin.console_email] ?? "";
	const password = target.values[plugin.console_password] ?? "";
	if (!email) throw new AppError("CLOUD_SYNC_EMAIL_MISSING");
	if (!password) {
		throw new AppError("APPWRITE_PLUGIN_CONFIG_INVALID", {
			detail: plugin.console_password,
		});
	}
	return { email, password };
}

/** A console session cookie (`create`: sign up first, on a new app). */
export async function consoleSession(
	client: ReturnType<typeof localClient>,
	plugin: AppwritePluginConfig,
	login: { email: string; password: string },
	create: boolean,
): Promise<string> {
	const account = create
		? await client.send(
				localRequests.createAccount(plugin, {
					...login,
					name: login.email,
				}),
			)
		: { status: null, body: "" };
	const session = await client.send(localRequests.createSession(plugin, login));
	const error = consoleSignInError(plugin, login.email, account, session);
	if (error) throw error;
	const cookie = sessionCookie(session.headers, plugin.console_project);
	if (!cookie) {
		throw new AppError("APPWRITE_REQUEST_FAILED", {
			action: `POST ${plugin.api_path}/account/sessions/email`,
			status: session.status ?? 0,
			detail: "Set-Cookie",
		});
	}
	return cookie;
}

function migrateStep(
	config: Config,
	source: { name: string },
	state: JobState,
): SyncStep {
	return {
		id: "migrate",
		part: null,
		run: async (run) => {
			const { target, job } = run;
			const settings = getConfig();
			const plugin = pluginConfig(target.pluginConfig);
			const client = localClient(target, plugin);
			const login = consoleLogin(target, plugin);
			state.secrets.push(login.password);
			job.event("appwrite_sync.waiting_api");
			await waitReady(client, plugin, job.signal);

			// Console admin: only this email may sign up (the template's
			// whitelist); if someone else got there first, stop here.
			const cookie = await consoleSession(client, plugin, login, true);
			state.secrets.push(cookie, cookie.split("=").slice(1).join("="));
			job.event("appwrite_sync.console_account", { email: login.email });
			const notes: NonNullable<typeof run.summary.notes> = [
				{ code: "CLOUD_NOTE_CONSOLE_ADMIN", params: { email: login.email } },
			];
			run.summary.notes = notes;

			const recovery: AppwriteRecoveryState = {
				projectId: config.projectId,
				keyId: null,
				migrationId: null,
			};
			let key: { id: string; secret: string } | null = null;
			try {
				const teamId = await organization(
					client,
					plugin,
					cookie,
					target.appName,
				);
				const project = await client.send(
					localRequests.createProject(plugin, cookie, {
						projectId: config.projectId,
						name: source.name,
						teamId,
					}),
				);
				if (project.status === 409) {
					throw new AppError("APPWRITE_PROJECT_EXISTS", {
						project: config.projectId,
					});
				}
				if (project.status !== 201 && project.status !== 200) {
					throw new AppError("APPWRITE_REQUEST_FAILED", {
						action: `POST ${plugin.api_path}/projects`,
						status: project.status ?? 0,
						detail: clip(project.body, TEXT_LIMITS.errorDetail),
					});
				}
				job.event("appwrite_sync.project_created", {
					project: config.projectId,
				});
				const created = await client.expect(
					localRequests.createKey(plugin, cookie, {
						projectId: config.projectId,
						name: resourceName(`import-${randomUUID().slice(0, 8)}`),
						// About the job's own limit: an orphan expires soon.
						expire: new Date(
							Date.now() +
								settings.CLOUD_SYNC_JOB_TIMEOUT_MS +
								settings.CLOUD_SYNC_APPWRITE_KEY_TTL_SLACK_MS,
						).toISOString(),
					}),
				);
				const body = (created.json ?? {}) as {
					$id?: unknown;
					secret?: unknown;
				};
				if (typeof body.secret !== "string" || typeof body.$id !== "string") {
					throw new AppError("APPWRITE_REQUEST_FAILED", {
						action: `POST ${plugin.api_path}/projects/{id}/keys`,
						status: created.status ?? 0,
						detail: "secret",
					});
				}
				key = { id: body.$id, secret: body.secret };
				state.secrets.push(key.secret);
				recovery.keyId = key.id;
				await run.checkpoint?.({ ...recovery });
				job.event("appwrite_sync.key_created");

				await migrate(run, plugin, client, config, key, state, recovery);
				notes.push({
					code: "CLOUD_NOTE_REVOKE_CLOUD_KEY",
					params: { project: config.projectId },
				});
			} finally {
				await cleanup(run, plugin, client, cookie, key, recovery);
			}
		},
	};
}

/**
 * The console organization the project goes to: the instance's only one
 * (self-hosted Appwrite allows one), created when there is none yet.
 */
async function organization(
	client: ReturnType<typeof localClient>,
	plugin: AppwritePluginConfig,
	cookie: string,
	name: string,
): Promise<string> {
	const listed = await client.expect(localRequests.listTeams(plugin, cookie));
	const existing = (listed.json as { teams?: { $id?: unknown }[] })?.teams?.[0];
	if (typeof existing?.$id === "string") return existing.$id;
	const team = await client.expect(
		localRequests.createTeam(plugin, cookie, name),
	);
	return String((team.json as { $id?: unknown })?.$id ?? "");
}

/**
 * Start a migration on its destination, follow it (one retry when nothing
 * was copied yet), log its errors and compare its counters with the
 * source's counts (import: the cloud's; export: the app's).
 */
export async function driveMigration(
	run: SyncRun,
	input: {
		resources: string[];
		start: () => Promise<string>;
		/** Record the id (checkpoint) before anything else can fail. */
		started: (id: string) => Promise<void>;
		read: (id: string) => Promise<MigrationStatus>;
		retry: (id: string) => Promise<void>;
		counts: AppwriteSourceCounts["resources"];
		mismatch: {
			event:
				| "appwrite_sync.resource_mismatch"
				| "appwrite_sync.export_resource_mismatch";
			warning:
				| "CLOUD_WARN_APPWRITE_RESOURCE_MISMATCH"
				| "CLOUD_WARN_EXPORT_RESOURCE_MISMATCH";
		};
	},
): Promise<void> {
	const settings = getConfig();
	const { resources } = input;
	const id = await input.start();
	await input.started(id);
	run.job.event("appwrite_sync.migration_started", {
		migration: id,
		resources: asList(resources),
	});
	const read = () => input.read(id);
	let status = await follow(run, read);
	// A retry re-runs the whole migration: only worth it when nothing was
	// copied or refused yet (e.g. the source was briefly unreachable);
	// otherwise every copied resource fails again as a duplicate.
	const first = migrationProgress(status);
	if (status.status === "failed" && first.success === 0 && first.errors === 0) {
		run.job.event("appwrite_sync.migration_retry", {
			error: { $error: errorInfoOf(migrationError(status)) },
		});
		await input.retry(id);
		status = await follow(run, read);
	}
	for (const error of status.errors.slice(
		0,
		settings.CLOUD_SYNC_APPWRITE_MAX_LOGGED_ERRORS,
	)) {
		run.job.event("appwrite_sync.migration_error", {
			resource: error.resource,
			message: clip(error.message, TEXT_LIMITS.errorDetail),
		});
	}
	// What arrived is kept in the summary even when the migration failed.
	const compared = compareMigration(input.counts, status, resources);
	run.summary.resources = compared.rows;
	if (status.status === "failed") throw migrationError(status);
	const progress = migrationProgress(status);
	run.job.event("appwrite_sync.migrated", {
		success: progress.success,
		errors: progress.errors,
	});
	if (status.errors.length > 0) {
		await run.warn(
			coded("CLOUD_WARN_APPWRITE_MIGRATION_ERRORS", {
				count: status.errors.length,
			}),
		);
	}
	for (const mismatch of compared.mismatches) {
		run.job.event(input.mismatch.event, mismatch);
		await run.warn(coded(input.mismatch.warning, mismatch));
	}
}

async function migrate(
	run: SyncRun,
	plugin: AppwritePluginConfig,
	client: ReturnType<typeof localClient>,
	config: Config,
	key: { id: string; secret: string },
	state: JobState,
	recovery: AppwriteRecoveryState,
) {
	const auth = { project: config.projectId, secret: key.secret };
	const resources = migrationResources(plugin, run.parts);
	await driveMigration(run, {
		resources,
		start: async () => {
			const started = await client.expect(
				localRequests.startMigration(plugin, auth, {
					endpoint: config.endpoint,
					projectId: config.projectId,
					apiKey: config.apiKey,
					resources,
				}),
				[200, 201, 202],
			);
			return parseMigration(started.json).id;
		},
		started: async (id) => {
			recovery.migrationId = id;
			await run.checkpoint?.({ ...recovery });
		},
		read: async (id) =>
			parseMigration(
				(await client.expect(localRequests.getMigration(plugin, auth, id)))
					.json,
			),
		retry: async (id) => {
			await client.expect(
				localRequests.retryMigration(plugin, auth, id),
				[200, 201, 202, 204],
			);
		},
		counts: state.counts?.resources ?? {},
		mismatch: {
			event: "appwrite_sync.resource_mismatch",
			warning: "CLOUD_WARN_APPWRITE_RESOURCE_MISMATCH",
		},
	});
}

/**
 * After the run (best effort, in this order): remove the migration (its
 * document stores the cloud API key), the temporary key, the session.
 */
async function cleanup(
	run: SyncRun,
	plugin: AppwritePluginConfig,
	client: ReturnType<typeof localClient>,
	cookie: string,
	key: { id: string; secret: string } | null,
	recovery: AppwriteRecoveryState,
) {
	const failures = await removeLeftovers(client, plugin, cookie, recovery, key);
	for (const error of failures) {
		run.job.event("appwrite_sync.cleanup_failed", {
			error: { $error: errorInfoOf(error) },
		});
	}
	if (failures.length === 0) await run.checkpoint?.(null);
}

/** Delete what an import leaves in the new app; returns what failed. */
async function removeLeftovers(
	client: ReturnType<typeof localClient>,
	plugin: AppwritePluginConfig,
	cookie: string,
	recovery: AppwriteRecoveryState,
	key: { id: string; secret: string } | null,
): Promise<unknown[]> {
	const requests: LocalRequest[] = [];
	if (recovery.migrationId) {
		requests.push(
			localRequests.deleteMigration(
				plugin,
				key
					? { kind: "key", project: recovery.projectId, secret: key.secret }
					: { kind: "admin", project: recovery.projectId, cookie },
				recovery.migrationId,
			),
		);
	}
	if (recovery.keyId) {
		requests.push(
			localRequests.deleteKey(plugin, cookie, {
				projectId: recovery.projectId,
				keyId: recovery.keyId,
			}),
		);
	}
	requests.push(localRequests.deleteSession(plugin, cookie));
	const failures: unknown[] = [];
	for (const request of requests) {
		try {
			// 404: already gone (e.g. removed by an earlier attempt).
			await client.expect(request, [200, 204, 404]);
		} catch (error) {
			failures.push(error);
		}
	}
	return failures;
}

/**
 * After a panel restart killed an import: sign in as the console admin and
 * remove the migration (it stores the cloud key) and the temporary key.
 */
async function recover(input: {
	state: unknown;
	target: SyncTarget;
	connection?: { provider: CloudSyncProvider; config: Record<string, unknown> };
}): Promise<void> {
	if (isExportRecovery(input.state)) {
		await recoverExport({ ...input, state: input.state });
		return;
	}
	if (!isRecoveryState(input.state)) return;
	const plugin = pluginConfig(input.target.pluginConfig);
	const client = localClient(input.target, plugin);
	const cookie = await consoleSession(
		client,
		plugin,
		consoleLogin(input.target, plugin),
		false,
	);
	const failures = await removeLeftovers(
		client,
		plugin,
		cookie,
		input.state,
		null,
	);
	if (failures.length > 0) throw failures[0];
}

async function open(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
	direction: SyncDirection,
	source?: ExportSource,
): Promise<OpenedSync> {
	if (direction === "export") {
		if (!source) throw internalError("Export without its app");
		return openExport(provider, raw, source);
	}
	const config = parse(provider, raw);
	await checkEndpoint(provider, config);
	const api: AppwriteApi = appwriteApi(provider, config);
	const version = await api.version();
	const name = (await api.projectName()) ?? config.projectId;
	const plugin = await templatePlugin(provider);
	const state: JobState = { secrets: [], counts: null };
	return {
		project: config.projectId,
		region: endpointRegion(config.endpoint),
		version,
		secrets: () => state.secrets,
		prepare: async (parts) => {
			// The counts the migration's counters are compared with.
			state.counts = await countSource(api, migrationResources(plugin, parts));
		},
		steps: () => [migrateStep(config, { name }, state)],
	};
}

export const appwriteDriver: CloudSyncDriver = {
	test,
	targetVersion,
	preflight,
	importInputs,
	open,
	recover,
	exportOptions,
};
