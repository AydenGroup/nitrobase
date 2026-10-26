import { randomUUID } from "node:crypto";
import type { CloudSyncProvider } from "#/config/cloud-sync.ts";
import { resourceName } from "#/config/identifiers.ts";
import { getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import type { AppwritePluginConfig } from "#/features/appwrite/schema.ts";
import { clip } from "#/libs/format.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import { pinnedRequest } from "#/server/services/pinned-http.ts";
import { AppError } from "#/utils/error.ts";
import {
	checkEndpoint,
	consoleLogin,
	consoleSession,
	driveMigration,
	endpointRegion,
	localClient,
	parse,
	pluginConfig,
	previewContents,
} from "./appwrite";
import {
	type AppwriteApi,
	type AppwriteCloud,
	type AppwriteSourceCounts,
	appwriteApi,
	appwriteCloud,
	countEmptiness,
	countSource,
	listQuery,
} from "./appwrite-api";
import {
	type LocalAuth,
	localRequests,
	migrationResources,
	parseMigration,
} from "./appwrite-local";
import { analyzeAppwriteExport, type Reachability } from "./appwrite-preflight";
import { errorDetail } from "./http";
import type {
	CloudPreflight,
	CloudSyncDriver,
	ExportOptions,
	ExportSource,
	OpenedSync,
	PreflightContent,
	SyncRun,
	SyncStep,
	SyncTarget,
} from "./types";

/**
 * Appwrite export: a self-hosted Appwrite app → an EMPTY Appwrite Cloud
 * project, through Appwrite's own Migrations run ON THE CLOUD (the
 * destination pulls from the source over its REST API):
 * - the cloud reads the app at its public HTTPS address (checked by the
 *   panel first: TLS verified, same version as the app runs);
 * - with a temporary read-only key the panel creates in the app's project
 *   (signed in as the console admin an import created), or a key the
 *   member enters for this export only;
 * - the panel starts `POST /v1/migrations/appwrite` on the cloud with the
 *   connection's key, follows it, compares the counters with the app's
 *   counts, then removes the cloud's migration record (it stores the
 *   app's key) and the temporary key, whatever happened.
 */

type Client = ReturnType<typeof localClient>;

/** How the export reads the app's project. */
interface LocalAccess {
	projectId: string;
	auth: LocalAuth;
	/** Console session (managed key); null: the member's key. */
	cookie: string | null;
	/** The member's key (handed to the cloud as is). */
	givenKey: string | null;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

function hasConsoleLogin(target: SyncTarget, plugin: AppwritePluginConfig) {
	return (
		!!target.values[plugin.console_email] &&
		!!target.values[plugin.console_password]
	);
}

async function listProjects(
	client: Client,
	plugin: AppwritePluginConfig,
	cookie: string,
): Promise<{ id: string; name: string }[]> {
	const listed = await client.expect(
		localRequests.listProjects(plugin, cookie),
	);
	const projects = (listed.json as { projects?: Record<string, unknown>[] })
		?.projects;
	return (projects ?? [])
		.map((project) => ({ id: text(project.$id), name: text(project.name) }))
		.filter((project) => project.id && project.id !== plugin.console_project);
}

/** Sign in (console admin) or take the member's key; pick the project. */
async function localAccess(
	client: Client,
	plugin: AppwritePluginConfig,
	source: ExportSource,
): Promise<LocalAccess> {
	const projectId = text(source.inputs.localProjectId);
	const givenKey = text(source.inputs.localApiKey);
	if (hasConsoleLogin(source.target, plugin)) {
		const cookie = await consoleSession(
			client,
			plugin,
			consoleLogin(source.target, plugin),
			false,
		);
		try {
			const projects = await listProjects(client, plugin, cookie);
			const picked = projectId
				? projects.find((project) => project.id === projectId)
				: projects.length === 1
					? projects[0]
					: undefined;
			if (!picked) {
				throw projectId || projects.length === 0
					? new AppError("CLOUD_EXPORT_LOCAL_PROJECT_NOT_FOUND", {
							project: projectId,
						})
					: new AppError("CLOUD_EXPORT_INPUT_INVALID", {
							field: "localProjectId",
							detail: "",
						});
			}
			return {
				projectId: picked.id,
				auth: { kind: "admin", project: picked.id, cookie },
				cookie,
				givenKey: null,
			};
		} catch (error) {
			await signOut(client, plugin, cookie);
			throw error;
		}
	}
	if (!projectId || !givenKey) {
		throw new AppError("CLOUD_EXPORT_LOCAL_KEY_REQUIRED");
	}
	return {
		projectId,
		auth: { kind: "key", project: projectId, secret: givenKey },
		cookie: null,
		givenKey,
	};
}

async function signOut(
	client: Client,
	plugin: AppwritePluginConfig,
	cookie: string,
): Promise<void> {
	await client
		.expect(localRequests.deleteSession(plugin, cookie), [200, 204, 404])
		.catch(() => undefined);
}

/**
 * The app's API as `countSource` reads it (lists through the gateway): a
 * refused read is `CLOUD_API_UNAUTHORIZED` (counted as refused), a
 * missing route `CLOUD_API_FAILED` 404 (older releases).
 */
function localApi(
	client: Client,
	plugin: AppwritePluginConfig,
	auth: LocalAuth,
): AppwriteApi {
	return {
		version: () => localVersion(client, plugin),
		projectName: async () => null,
		list: async (path, key, options = {}) => {
			const queries = [listQuery("limit", options.limit ?? 1)];
			if (options.cursor) {
				queries.push(listQuery("cursorAfter", options.cursor));
			}
			const request = localRequests.list(plugin, auth, path, queries);
			const response = await client.send(request);
			const detail = clip(response.body, TEXT_LIMITS.errorDetail);
			if (response.status === 401 || response.status === 403) {
				throw new AppError("CLOUD_API_UNAUTHORIZED", { detail });
			}
			if (response.status === 404) {
				throw new AppError("CLOUD_API_FAILED", { status: 404, detail });
			}
			if (response.status !== 200) {
				throw new AppError("APPWRITE_REQUEST_FAILED", {
					action: `GET ${plugin.api_path}${path}`,
					status: response.status ?? 0,
					detail,
				});
			}
			const body = (response.json ?? {}) as Record<string, unknown>;
			const items = body[key];
			return {
				total: typeof body.total === "number" ? body.total : 0,
				items: Array.isArray(items) ? (items as Record<string, unknown>[]) : [],
			};
		},
	};
}

async function localVersion(
	client: Client,
	plugin: AppwritePluginConfig,
): Promise<string> {
	const response = await client.expect(localRequests.health(plugin));
	const version = text((response.json as { version?: unknown })?.version);
	if (!version) {
		throw new AppError("APPWRITE_REQUEST_FAILED", {
			action: `GET ${plugin.api_path}/health/version`,
			status: response.status ?? 0,
			detail: clip(response.body, TEXT_LIMITS.errorDetail),
		});
	}
	return version;
}

/** The app's API base the cloud reads (`https://<domain>/v1`). */
export function sourceEndpoint(
	publicUrl: string | null,
	plugin: AppwritePluginConfig,
): string | null {
	return publicUrl
		? `${publicUrl.replace(/\/+$/, "")}${plugin.api_path}`
		: null;
}

/**
 * The app as the cloud will reach it: an Appwrite of the app's own version
 * answers `/health/version` at its public HTTPS address, with a certificate
 * the cloud accepts. That is all it proves: it cannot tell this instance
 * from another of the same version. Reading the wrong instance is prevented
 * by the key the cloud gets, which only works on this app's project.
 */
export async function checkReachability(
	endpoint: string | null,
	plugin: AppwritePluginConfig,
	version: string | null,
): Promise<Reachability> {
	if (!endpoint) return { kind: "no_url" };
	const config = getConfig();
	if (config.CLOUD_SYNC_EXPORT_SKIP_REACHABILITY) return { kind: "skipped" };
	const url = `${endpoint}/health/version`;
	try {
		const response = await pinnedRequest({
			url,
			method: "GET",
			headers: {
				accept: "application/json",
				"x-appwrite-project": plugin.console_project,
			},
			// The cloud connects from the internet: a private address or a
			// certificate it would refuse is refused here too.
			allowPrivate: false,
			timeoutMs: config.CLOUD_SYNC_HTTP_TIMEOUT_MS,
			maxResponseBytes: config.CLOUD_SYNC_EXPORT_HEALTH_MAX_BYTES,
		});
		if (response.status !== 200) {
			return { kind: "unreachable", url, detail: `HTTP ${response.status}` };
		}
		let found = "";
		try {
			found = text(
				(JSON.parse(response.body.toString("utf8")) as { version?: unknown })
					.version,
			);
		} catch {
			found = "";
		}
		return found && found === version
			? { kind: "ok" }
			: { kind: "mismatch", url, found: found || "?" };
	} catch (error) {
		return {
			kind: "unreachable",
			url,
			detail: errorDetail(error),
		};
	}
}

/** Preflight rows of what the cloud project holds (all 0: empty). */
function cloudRows(counts: Record<string, number>): PreflightContent[] {
	const row = (
		part: string,
		items: [string, PreflightContent["counts"][0]["unit"]][],
	): PreflightContent => ({
		part,
		sizeBytes: null,
		counts: items
			.filter(([resource]) => resource in counts)
			.map(([resource, unit]) => ({ unit, count: counts[resource] ?? 0 })),
	});
	return [
		row("auth", [
			["user", "users"],
			["team", "teams"],
		]),
		row("databases", [["database", "databases"]]),
		row("storage", [["bucket", "buckets"]]),
		row("function_settings", [["function", "functions"]]),
		row("platforms", [["platform", "platforms"]]),
	];
}

/** What the modal can offer: the app's projects when the panel signs in. */
export async function exportOptions(
	source: ExportSource,
): Promise<ExportOptions> {
	const plugin = pluginConfig(source.target.pluginConfig);
	if (!hasConsoleLogin(source.target, plugin)) {
		return { projects: null, hidden: [] };
	}
	const client = localClient(source.target, plugin);
	const cookie = await consoleSession(
		client,
		plugin,
		consoleLogin(source.target, plugin),
		false,
	);
	try {
		return {
			projects: await listProjects(client, plugin, cookie),
			projectField: "localProjectId",
			hidden: ["localApiKey"],
		};
	} finally {
		await signOut(client, plugin, cookie);
	}
}

export async function exportPreflight(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
	input: Parameters<CloudSyncDriver["preflight"]>[2],
	source: ExportSource,
): Promise<CloudPreflight> {
	const config = parse(provider, raw);
	await checkEndpoint(provider, config);
	const api = appwriteApi(provider, config);
	const cloud = appwriteCloud(provider, config);
	const plugin = pluginConfig(source.target.pluginConfig);
	const cloudVersion = await api.version();
	const name = (await api.projectName()) ?? config.projectId;
	const emptiness = await countEmptiness(api);
	const canWrite = await cloud.canStartMigrations();
	const client = localClient(source.target, plugin);
	const version = await localVersion(client, plugin);
	const access = await localAccess(client, plugin, source);
	let counts: AppwriteSourceCounts;
	try {
		counts = await countSource(
			localApi(client, plugin, access.auth),
			migrationResources(plugin, input.parts),
		);
	} finally {
		if (access.cookie) await signOut(client, plugin, access.cookie);
	}
	const endpoint = sourceEndpoint(source.publicUrl, plugin);
	const analysis = analyzeAppwriteExport({
		parts: input.parts,
		cloudProjectId: config.projectId,
		localProjectId: access.projectId,
		localVersion: version,
		cloudVersion,
		cloud: emptiness.counts,
		cloudRefused: emptiness.refused,
		canWrite,
		cloudScopes: plugin.sync_cloud_key_scopes,
		reachability: await checkReachability(endpoint, plugin, version),
		givenKey: access.givenKey !== null,
		refused: counts.refused,
		partial: counts.partial,
	});
	return {
		direction: "export",
		project: {
			id: config.projectId,
			name,
			region: endpointRegion(config.endpoint),
			status: "",
		},
		versions: { source: cloudVersion, target: version },
		target: { ...input.target, version },
		contents: previewContents(plugin, input.parts, counts),
		cloud: cloudRows(emptiness.counts),
		...analysis,
	};
}

/** Throw unless the cloud project is (still) empty. */
async function assertCloudEmpty(api: AppwriteApi): Promise<void> {
	const { counts, refused } = await countEmptiness(api);
	if (refused.length > 0) {
		throw new AppError("CLOUD_EXPORT_EMPTINESS_UNKNOWN", {
			detail: refused.join(", "),
		});
	}
	const items = Object.entries(counts)
		.filter(([, count]) => count > 0)
		.map(([resource, count]) => `${resource}: ${count}`);
	if (items.length > 0) {
		throw new AppError("CLOUD_EXPORT_NOT_EMPTY", { items: { $list: items } });
	}
}

/** What a crash recovery of an export removes (ids only, never secrets). */
export interface AppwriteExportRecovery {
	direction: "export";
	/** The app's project and the temporary key the panel created in it. */
	localProjectId: string;
	localKeyId: string | null;
	/** The migration on the cloud (it stores the app's key). */
	cloudMigrationId: string | null;
}

export function isExportRecovery(
	value: unknown,
): value is AppwriteExportRecovery {
	const state = value as Partial<AppwriteExportRecovery> | null;
	return (
		!!state &&
		state.direction === "export" &&
		typeof state.localProjectId === "string" &&
		(state.localKeyId === null || typeof state.localKeyId === "string") &&
		(state.cloudMigrationId === null ||
			typeof state.cloudMigrationId === "string")
	);
}

/** Remove the cloud's migration and the app's temporary key (best effort). */
async function removeExportLeftovers(input: {
	cloud: AppwriteCloud | null;
	client: Client;
	plugin: AppwritePluginConfig;
	cookie: string | null;
	recovery: AppwriteExportRecovery;
}): Promise<unknown[]> {
	const failures: unknown[] = [];
	const { recovery } = input;
	if (recovery.cloudMigrationId && input.cloud) {
		await input.cloud
			.deleteMigration(recovery.cloudMigrationId)
			.catch((error) => failures.push(error));
	}
	if (recovery.localKeyId && input.cookie) {
		await input.client
			.expect(
				localRequests.deleteKey(input.plugin, input.cookie, {
					projectId: recovery.localProjectId,
					keyId: recovery.localKeyId,
				}),
				[200, 204, 404],
			)
			.catch((error) => failures.push(error));
	}
	return failures;
}

function exportStep(
	provider: CloudSyncProvider,
	config: ReturnType<typeof parse>,
	source: ExportSource,
	secrets: string[],
): SyncStep {
	return {
		id: "migrate_export",
		part: null,
		run: async (run: SyncRun) => {
			const settings = getConfig();
			const { target, job } = run;
			const plugin = pluginConfig(target.pluginConfig);
			const client = localClient(target, plugin);
			const cloud = appwriteCloud(provider, config);
			const resources = migrationResources(plugin, run.parts);
			const endpoint = sourceEndpoint(source.publicUrl, plugin);
			if (!endpoint) throw new AppError("CLOUD_EXPORT_NO_PUBLIC_URL");
			const access = await localAccess(client, plugin, source);
			if (access.cookie) {
				secrets.push(
					access.cookie,
					access.cookie.split("=").slice(1).join("="),
				);
				job.event("appwrite_sync.export_signed_in", {
					email: target.values[plugin.console_email] ?? "",
				});
			}
			const recovery: AppwriteExportRecovery = {
				direction: "export",
				localProjectId: access.projectId,
				localKeyId: null,
				cloudMigrationId: null,
			};
			try {
				let key = access.givenKey;
				if (access.cookie) {
					if (plugin.sync_export_key_scopes.length === 0) {
						throw new AppError("APPWRITE_PLUGIN_CONFIG_INVALID", {
							detail: "sync_export_key_scopes",
						});
					}
					const created = await client.expect(
						localRequests.createKey(plugin, access.cookie, {
							projectId: access.projectId,
							name: resourceName(`export-${randomUUID().slice(0, 8)}`),
							scopes: plugin.sync_export_key_scopes,
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
					key = body.secret;
					secrets.push(body.secret);
					recovery.localKeyId = body.$id;
					await run.checkpoint?.({ ...recovery });
					job.event("appwrite_sync.export_key_created", {
						project: access.projectId,
					});
				} else {
					job.event("appwrite_sync.export_given_key", {
						project: access.projectId,
					});
				}
				const counts = await countSource(
					localApi(client, plugin, access.auth),
					resources,
				);
				const apiKey = key ?? "";
				await driveMigration(run, {
					resources,
					start: async () =>
						parseMigration(
							await cloud.startMigration({
								endpoint,
								projectId: access.projectId,
								apiKey,
								resources,
							}),
						).id,
					started: async (id) => {
						recovery.cloudMigrationId = id;
						await run.checkpoint?.({ ...recovery });
					},
					read: async (id) => parseMigration(await cloud.getMigration(id)),
					retry: (id) => cloud.retryMigration(id),
					counts: counts.resources,
					mismatch: {
						event: "appwrite_sync.export_resource_mismatch",
						warning: "CLOUD_WARN_EXPORT_RESOURCE_MISMATCH",
					},
				});
				run.summary.notes = [
					{
						code: "CLOUD_NOTE_EXPORT_APPWRITE_NEXT",
						params: { project: config.projectId },
					},
					...(access.givenKey
						? [
								{
									code: "CLOUD_NOTE_REVOKE_EXPORT_KEY",
									params: { project: access.projectId },
								},
							]
						: []),
				];
			} finally {
				const failures = await removeExportLeftovers({
					cloud,
					client,
					plugin,
					cookie: access.cookie,
					recovery,
				});
				if (access.cookie) await signOut(client, plugin, access.cookie);
				for (const error of failures) {
					job.event("appwrite_sync.export_cleanup_failed", {
						error: { $error: errorInfoOf(error) },
					});
				}
				if (failures.length === 0) await run.checkpoint?.(null);
			}
		},
	};
}

export async function openExport(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
	source: ExportSource,
): Promise<OpenedSync> {
	const config = parse(provider, raw);
	await checkEndpoint(provider, config);
	const api = appwriteApi(provider, config);
	const version = await api.version();
	const secrets: string[] = [];
	return {
		project: config.projectId,
		region: endpointRegion(config.endpoint),
		version,
		secrets: () => secrets,
		prepare: async () => undefined,
		assertEmpty: () => assertCloudEmpty(api),
		steps: () => [exportStep(provider, config, source, secrets)],
	};
}

/**
 * After a panel restart killed an export: remove the cloud's migration
 * (with the connection's key) and the app's temporary key (signed in as
 * the console admin).
 */
export async function recoverExport(input: {
	state: AppwriteExportRecovery;
	target: SyncTarget;
	connection?: { provider: CloudSyncProvider; config: Record<string, unknown> };
}): Promise<void> {
	const plugin = pluginConfig(input.target.pluginConfig);
	const client = localClient(input.target, plugin);
	const cloud = input.connection
		? appwriteCloud(
				input.connection.provider,
				parse(input.connection.provider, input.connection.config),
			)
		: null;
	const cookie =
		input.state.localKeyId && hasConsoleLogin(input.target, plugin)
			? await consoleSession(
					client,
					plugin,
					consoleLogin(input.target, plugin),
					false,
				)
			: null;
	try {
		const failures = await removeExportLeftovers({
			cloud,
			client,
			plugin,
			cookie,
			recovery: input.state,
		});
		if (failures.length > 0) throw failures[0];
	} finally {
		if (cookie) await signOut(client, plugin, cookie);
	}
}
