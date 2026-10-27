import { and, desc, eq } from "drizzle-orm";
import type { CloudSyncProvider, SyncPart } from "#/config/cloud-sync.ts";
import { jobTitle } from "#/config/job-titles.ts";
import { describeSchemaError } from "#/config/schema-fields.ts";
import { hostPaths } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import {
	type CloudSyncSummary,
	cloudConnections,
	cloudSyncs,
} from "#/db/schema/cloud-sync.ts";
import { deployments } from "#/db/schema/server.ts";
import { users } from "#/db/schema/user.ts";
import { runDeploy, startAppJob } from "#/features/apps/app-jobs.server.ts";
import {
	createAppRecord,
	getAppManifest,
	getAppRow,
	getAppServer,
} from "#/features/apps/apps.server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess } from "#/features/auth/access.ts";
import { pickServer } from "#/features/backups/destinations.server.ts";
import { newWorkDir } from "#/features/backups/rclone.server.ts";
import {
	type JobContext,
	type JobOutcome,
	redactingContext,
} from "#/features/deployments/deployments.server.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import {
	getTemplateManifest,
	getTemplateVersions,
	renderTemplate,
} from "#/features/templates/templates.server.ts";
import { audit } from "#/server/services/audit.ts";
import { removeWorkDirCommand } from "#/server/services/backup/archive.ts";
import { redactor } from "#/server/services/backup/rclone.ts";
import {
	freeDiskCommand,
	parseFreeDisk,
	prepareSyncWorkDirCommand,
} from "#/server/services/cloud-sync/commands.ts";
import type {
	CloudPreflight,
	CloudSyncDriver,
	SyncPreflightTarget,
	TemplateProbe,
} from "#/server/services/cloud-sync/types.ts";
import { lastErrorColumns, redactError } from "#/server/services/error-info.ts";
import type { Executor } from "#/server/services/executor.ts";
import { AppError } from "#/utils/error.ts";
import { connectionConfig, getConnectionRow } from "./connections.server";
import type { CloudImportInput, CloudSyncDTO, CloudSyncRow } from "./schema";
import {
	appSyncTarget,
	asAppError,
	assertParts,
	finishSync,
	runSyncSteps,
} from "./sync-job.server";

/**
 * Import a cloud project into a NEW app (like "restore as a new app"): the
 * app is created from the provider's template, deployed, then the driver's
 * steps copy each chosen part into it and compare the result.
 */

/** `provider.importSchema` values of this run (never stored). */
export function parseImportInputs(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
): Record<string, unknown> {
	const parsed = provider.importSchema.safeParse(raw);
	if (!parsed.success) {
		throw new AppError(
			"CLOUD_IMPORT_INPUT_INVALID",
			describeSchemaError(provider.importSchema, parsed.error),
		);
	}
	return parsed.data as Record<string, unknown>;
}

/**
 * The release a new app of `templateId` deploys: the picked one, else the
 * latest stable one (null: none could be listed).
 */
async function resolveRelease(
	templateId: string,
	picked: string | undefined,
): Promise<string | null> {
	if (picked) {
		const { versions } = await getTemplateVersions(templateId, {
			includePrereleases: true,
		});
		if (!versions.some((version) => version.ref === picked)) {
			throw new AppError("TEMPLATE_VERSION_NOT_OFFERED", { version: picked });
		}
		return picked;
	}
	try {
		return (await getTemplateVersions(templateId)).defaultRef;
	} catch {
		return null;
	}
}

/** What the driver needs to tell the new app's version. */
async function templateProbe(
	templateId: string,
	release: string | null,
): Promise<TemplateProbe> {
	const manifest = await getTemplateManifest(templateId);
	return {
		templateId,
		version: release,
		manifest,
		compose: async () =>
			(
				await renderTemplate({
					templateId,
					...(release ? { version: release } : {}),
				})
			).compose,
	};
}

async function freeDisk(executor: Executor): Promise<number | null> {
	const result = await executor.exec(freeDiskCommand(hostPaths().root));
	return result.exitCode === 0 ? parseFreeDisk(result.stdout) : null;
}

async function preflightTarget(
	server: ServerRow,
	provider: CloudSyncProvider,
	driver: CloudSyncDriver,
	picked: string | undefined,
): Promise<SyncPreflightTarget> {
	const release = await resolveRelease(provider.templateId, picked);
	const version = await templateProbe(provider.templateId, release)
		.then((probe) => driver.targetVersion(probe))
		.catch(() => null);
	const executor = await getExecutor(server);
	try {
		return {
			serverName: server.name,
			freeDiskBytes: await freeDisk(executor),
			version,
			release,
		};
	} finally {
		executor.close();
	}
}

/** Preview an import: sizes, versions, disk and what will not carry over. */
export async function previewCloudImport(
	actor: Actor,
	input: {
		connectionId: string;
		serverId: string;
		parts: SyncPart[];
		version?: string;
		inputs?: Record<string, unknown>;
	},
): Promise<CloudPreflight> {
	assertCanAccess(actor, "app.sync");
	const row = await getConnectionRow(actor, input.connectionId);
	const { provider, driver, config, redact } = connectionConfig(row);
	assertParts(provider, "import", input.parts);
	const inputs = parseImportInputs(provider, input.inputs ?? {});
	const server = await pickServer(actor, input.serverId);
	const target = await preflightTarget(server, provider, driver, input.version);
	try {
		return await driver.preflight(provider, config, {
			direction: "import",
			parts: input.parts,
			target,
			inputs,
		});
	} catch (error) {
		throw redactError(error, redact);
	}
}

/** Email of the member acting (null: an API token or a system job). */
async function actorEmail(actor: Actor): Promise<string | null> {
	if (!actor.userId) return null;
	const [user] = await db
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, actor.userId))
		.limit(1);
	return user?.email ?? null;
}

export async function startCloudImport(
	actor: Actor,
	input: CloudImportInput,
): Promise<{ appId: string; deploymentId: string }> {
	const preflight = await previewCloudImport(actor, input);
	const blocker = preflight.blockers[0];
	if (blocker) throw asAppError(blocker);
	const row = await getConnectionRow(actor, input.connectionId);
	const { provider, driver } = connectionConfig(row);
	const inputs = driver.importInputs
		? driver.importInputs({
				pluginConfig: (await getTemplateManifest(provider.templateId)).plugin,
				email: await actorEmail(actor),
			})
		: {};
	const app = await createAppRecord(actor, {
		templateId: provider.templateId,
		serverId: input.serverId,
		name: input.name,
		domain: input.domain || undefined,
		// The release the preflight compared (it may have been the latest).
		version: preflight.target.release ?? undefined,
		inputs,
		acknowledged: false,
	});
	const [sync] = await db
		.insert(cloudSyncs)
		.values({
			teamId: actor.teamId,
			appId: app.id,
			connectionId: row.id,
			connectionName: row.name,
			provider: provider.id,
			direction: "import",
			project: preflight.project.id,
			parts: input.parts,
			summary: {
				warnings: preflight.warnings.map((warning) => ({
					code: warning.code ?? "",
					params: warning.params ?? {},
				})),
			},
		})
		.returning({ id: cloudSyncs.id });
	audit({
		actor,
		action: "app.create",
		targetType: "app",
		targetId: app.id,
	});
	audit({
		actor,
		action: provider.importAuditAction,
		targetType: "app",
		targetId: app.id,
		meta: {
			connectionId: row.id,
			project: preflight.project.id,
			parts: input.parts,
		},
	});
	let deploymentId: string;
	try {
		({ deploymentId } = await startAppJob(
			app,
			actor,
			provider.importJobType,
			jobTitle("cloud_import", {
				app: app.name,
				project: preflight.project.id,
			}),
			(ctx) =>
				runCloudImport(
					{
						appId: app.id,
						connectionId: row.id,
						parts: input.parts,
						syncId: sync.id,
						inputs: parseImportInputs(provider, input.inputs ?? {}),
					},
					ctx,
				),
		));
	} catch (error) {
		// Nothing ran (e.g. the server is busy): no half-made app is left.
		await db.delete(apps).where(eq(apps.id, app.id));
		throw error;
	}
	await db
		.update(cloudSyncs)
		.set({ deploymentId })
		.where(eq(cloudSyncs.id, sync.id));
	return { appId: app.id, deploymentId };
}

/** The import job: deploy the new app, then the driver's steps. */
async function runCloudImport(
	input: {
		appId: string;
		connectionId: string;
		parts: SyncPart[];
		syncId: string;
		/** `provider.importSchema` values (parsed). */
		inputs?: Record<string, unknown>;
	},
	ctx: JobContext,
): Promise<JobOutcome> {
	const [syncRow] = await db
		.select()
		.from(cloudSyncs)
		.where(eq(cloudSyncs.id, input.syncId))
		.limit(1);
	const summary: CloudSyncSummary = { ...(syncRow?.summary ?? {}) };
	summary.warnings ??= [];
	let redact = (text: string) => text;
	let executor: Executor | null = null;
	let workDir: string | null = null;
	ctx.setCancelState?.("cloud_import_partial");
	try {
		const [connection] = await db
			.select()
			.from(cloudConnections)
			.where(eq(cloudConnections.id, input.connectionId))
			.limit(1);
		if (!connection) throw new AppError("CLOUD_CONNECTION_NOT_FOUND");
		const { provider, driver, config, secrets } = connectionConfig(connection);
		const opened = await driver.open(
			provider,
			config,
			"import",
			undefined,
			input.inputs ?? {},
		);
		const scrub = () => redactor([...secrets, ...opened.secrets()]);
		redact = (text) => scrub()(text);
		const job = redactingContext(ctx, (text) => redact(text));
		job.event("cloud_sync.opened", {
			project: opened.project,
			region: opened.region,
			product: provider.id,
			version: opened.version,
		});
		await opened.prepare(input.parts);

		job.event("cloud_sync.deploying");
		const deployed = await runDeploy(input.appId, "deploy", undefined, job, {
			nested: true,
		});
		if (!deployed.success) {
			await finishSync(input.syncId, "failed", summary);
			return deployed;
		}

		const [app] = await db
			.select()
			.from(apps)
			.where(eq(apps.id, input.appId))
			.limit(1);
		if (!app) throw new AppError("APP_NOT_FOUND");
		const manifest = await getAppManifest(app);
		executor = await getExecutor(await getAppServer(app));
		const exec = executor;
		workDir = newWorkDir("cloud-import");
		await ctx.setWorkDir?.(workDir);
		const prepared = await exec.exec(prepareSyncWorkDirCommand(workDir));
		if (prepared.exitCode !== 0) {
			throw new AppError("FOLDER_CREATE_FAILED", {
				path: workDir,
				detail: prepared.stderr,
			});
		}
		const target = appSyncTarget(app, manifest.plugin, exec, {
			workDir,
			signal: ctx.signal,
			log: (chunk) => job.log(chunk),
			redact: (text) => redact(text),
			servicesStopped: async (services) => {
				await ctx.servicesStopped?.(services);
			},
			servicesStarted: async (services) => {
				await ctx.servicesStarted?.(services);
			},
		});
		await runSyncSteps({
			ctx,
			job,
			opened,
			parts: input.parts,
			target,
			summary,
			provider: provider.id,
			appId: app.id,
			syncId: input.syncId,
			partEvent: "cloud_sync.part",
		});
		await finishSync(input.syncId, "success", summary);
		job.event("cloud_sync.done", { project: opened.project, app: app.name });
		return { success: true };
	} catch (error) {
		const safe = redactError(error, redact);
		await finishSync(input.syncId, "failed", summary).catch(() => undefined);
		// The app may run with part of the data: its page shows why.
		await db
			.update(apps)
			.set(lastErrorColumns(safe))
			.where(eq(apps.id, input.appId))
			.catch(() => undefined);
		return { success: false, error: safe };
	} finally {
		if (executor && workDir) {
			await executor.exec(removeWorkDirCommand(workDir)).catch(() => undefined);
			await ctx.setWorkDir?.(null);
		}
		executor?.close();
	}
}

function toSyncDTO(row: CloudSyncRow): CloudSyncDTO {
	return {
		id: row.id,
		provider: row.provider,
		direction: row.direction,
		project: row.project,
		connectionId: row.connectionId,
		connectionName: row.connectionName,
		parts: row.parts,
		status: row.status,
		deploymentId: row.deploymentId,
		summary: row.summary ?? null,
		createdAt: row.createdAt,
		finishedAt: row.finishedAt,
	};
}

/** Syncs of an app, newest first (its origin is the oldest import). */
export async function listAppSyncs(
	actor: Actor,
	appId: string,
): Promise<CloudSyncDTO[]> {
	const app = await getAppRow(actor, appId);
	const rows = await db
		.select({ sync: cloudSyncs, jobStatus: deployments.status })
		.from(cloudSyncs)
		.leftJoin(deployments, eq(deployments.id, cloudSyncs.deploymentId))
		.where(and(eq(cloudSyncs.appId, app.id), eq(cloudSyncs.teamId, app.teamId)))
		.orderBy(desc(cloudSyncs.createdAt));
	return rows.map(({ sync, jobStatus }) =>
		toSyncDTO(
			// A job that died with the process never finished its row.
			sync.status === "running" && jobStatus && jobStatus !== "running"
				? { ...sync, status: "failed" }
				: sync,
		),
	);
}
