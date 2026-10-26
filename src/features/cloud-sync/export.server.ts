import { eq } from "drizzle-orm";
import {
	type CloudSyncProvider,
	exportSecretFields,
	type SyncPart,
} from "#/config/cloud-sync.ts";
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
import { startAppJob } from "#/features/apps/app-jobs.server.ts";
import {
	deployedServices,
	getAppManifest,
	getAppRow,
	getAppServer,
	listAppDomains,
} from "#/features/apps/apps.server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess } from "#/features/auth/access.ts";
import { newWorkDir } from "#/features/backups/rclone.server.ts";
import {
	type JobContext,
	type JobOutcome,
	redactingContext,
} from "#/features/deployments/deployments.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
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
	ExportOptions,
	ExportSource,
} from "#/server/services/cloud-sync/types.ts";
import { redactError } from "#/server/services/error-info.ts";
import type { Executor } from "#/server/services/executor.ts";
import { AppError, internalError } from "#/utils/error.ts";
import { connectionConfig, getConnectionRow } from "./connections.server";
import type {
	CloudExportInput,
	CloudExportOptionsInput,
	CloudExportPreflightInput,
} from "./schema";
import {
	appSyncTarget,
	asAppError,
	assertParts,
	finishSync,
	runSyncSteps,
} from "./sync-job.server";

/**
 * Export an app into an EMPTY cloud project (owner decision: never into
 * one that holds data). The preflight refuses a project with anything in
 * it, the job checks again before writing, and the member types the
 * project's ID to confirm. The app keeps running; it is only read.
 */

type AppRow = typeof apps.$inferSelect;

/** `provider.exportSchema` values (secrets: this job only, never stored). */
export function parseExportInputs(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
): Record<string, unknown> {
	const parsed = provider.exportSchema.safeParse(raw);
	if (!parsed.success) {
		throw new AppError(
			"CLOUD_EXPORT_INPUT_INVALID",
			describeSchemaError(provider.exportSchema, parsed.error),
		);
	}
	return parsed.data as Record<string, unknown>;
}

/** What the member typed must be the connection's project. */
export function assertConfirmed(project: string, typed: string): void {
	if (typed.trim() !== project) {
		throw new AppError("CLOUD_EXPORT_CONFIRM_MISMATCH", { project });
	}
}

/** `https://<primary domain>` (null: the app has no HTTPS primary domain). */
async function publicUrl(app: AppRow): Promise<string | null> {
	const primary = (await listAppDomains(app.id)).find(
		(domain) => domain.primary,
	);
	return primary?.https ? `https://${primary.host}` : null;
}

/** The app, its connection and the driver of an export (checks access). */
async function exportContext(
	actor: Actor,
	input: { appId: string; connectionId: string; inputs?: unknown },
) {
	assertCanAccess(actor, "app.sync");
	const app = await getAppRow(actor, input.appId, "app.sync");
	const row = await getConnectionRow(actor, input.connectionId);
	if (row.teamId !== app.teamId) {
		throw new AppError("CLOUD_CONNECTION_NOT_FOUND");
	}
	const connection = connectionConfig(row);
	const { provider } = connection;
	if (app.templateId !== provider.templateId) {
		throw new AppError("CLOUD_EXPORT_TEMPLATE_MISMATCH");
	}
	if (app.status !== "running" || deployedServices(app).length === 0) {
		throw new AppError("CLOUD_EXPORT_APP_NOT_DEPLOYED");
	}
	const inputs = parseExportInputs(
		provider,
		(input.inputs ?? {}) as Record<string, unknown>,
	);
	const inputSecrets = exportSecretFields(provider)
		.map((name) => inputs[name])
		.filter((value): value is string => typeof value === "string" && !!value);
	const secrets = [...connection.secrets, ...inputSecrets];
	return {
		app,
		row,
		...connection,
		inputs,
		secrets,
		redact: redactor(secrets),
	};
}

/** Run `fn` with the app reachable as an export source (no staging folder). */
async function withSource<T>(
	ctx: Awaited<ReturnType<typeof exportContext>>,
	fn: (source: ExportSource, executor: Executor) => Promise<T>,
): Promise<T> {
	const manifest = await getAppManifest(ctx.app);
	const executor = await getExecutor(await getAppServer(ctx.app));
	try {
		const target = appSyncTarget(ctx.app, manifest.plugin, executor, {
			workDir: "",
			redact: ctx.redact,
		});
		return await fn(
			{ target, publicUrl: await publicUrl(ctx.app), inputs: ctx.inputs },
			executor,
		);
	} catch (error) {
		throw redactError(error, ctx.redact);
	} finally {
		executor.close();
	}
}

/** What the export modal can offer (e.g. the app's projects). */
export async function cloudExportOptions(
	actor: Actor,
	input: CloudExportOptionsInput,
): Promise<ExportOptions> {
	const ctx = await exportContext(actor, input);
	if (!ctx.driver.exportOptions) return { projects: null, hidden: [] };
	const exportOptions = ctx.driver.exportOptions.bind(ctx.driver);
	return withSource(ctx, (source) => exportOptions(source));
}

/** Preview an export: the cloud must be empty; sizes, versions, warnings. */
export async function previewCloudExport(
	actor: Actor,
	input: CloudExportPreflightInput,
): Promise<CloudPreflight> {
	const ctx = await exportContext(actor, input);
	assertParts(ctx.provider, "export", input.parts);
	const server = await getAppServer(ctx.app);
	return withSource(ctx, async (source, executor) => {
		const disk = await executor.exec(freeDiskCommand(hostPaths().root));
		return {
			...(await ctx.driver.preflight(ctx.provider, ctx.config, {
				direction: "export",
				parts: input.parts,
				target: {
					serverName: server.name,
					freeDiskBytes:
						disk.exitCode === 0 ? parseFreeDisk(disk.stdout) : null,
					version: null,
				},
				source,
			})),
			direction: "export",
		};
	});
}

export async function startCloudExport(
	actor: Actor,
	input: CloudExportInput,
): Promise<{ deploymentId: string }> {
	const preflight = await previewCloudExport(actor, input);
	const blocker = preflight.blockers[0];
	if (blocker) throw asAppError(blocker);
	const ctx = await exportContext(actor, input);
	// Typed by the member, checked against the connection's own project.
	assertConfirmed(preflight.project.id, input.confirm);
	const { app, row, provider } = ctx;
	const [sync] = await db
		.insert(cloudSyncs)
		.values({
			teamId: app.teamId,
			appId: app.id,
			connectionId: row.id,
			connectionName: row.name,
			provider: provider.id,
			direction: "export",
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
		action: provider.exportAuditAction,
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
			provider.exportJobType,
			jobTitle("cloud_export", {
				app: app.name,
				project: preflight.project.id,
			}),
			(job) =>
				runCloudExport(
					{
						appId: app.id,
						connectionId: row.id,
						parts: input.parts,
						syncId: sync.id,
						// Held by the job only: never stored.
						inputs: ctx.inputs,
					},
					job,
				),
		));
	} catch (error) {
		await db.delete(cloudSyncs).where(eq(cloudSyncs.id, sync.id));
		throw error;
	}
	await db
		.update(cloudSyncs)
		.set({ deploymentId })
		.where(eq(cloudSyncs.id, sync.id));
	return { deploymentId };
}

/** The export job: check the cloud is still empty, then the driver's steps. */
async function runCloudExport(
	input: {
		appId: string;
		connectionId: string;
		parts: SyncPart[];
		syncId: string;
		inputs: Record<string, unknown>;
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
	/** Set once the job may have written to the cloud project. */
	let writing: string | null = null;
	ctx.setCancelState?.("cloud_export_partial");
	try {
		const [connection] = await db
			.select()
			.from(cloudConnections)
			.where(eq(cloudConnections.id, input.connectionId))
			.limit(1);
		if (!connection) throw new AppError("CLOUD_CONNECTION_NOT_FOUND");
		const { provider, driver, config, secrets } = connectionConfig(connection);
		const inputSecrets = exportSecretFields(provider)
			.map((name) => input.inputs[name])
			.filter((value): value is string => typeof value === "string");
		const known = [...secrets, ...inputSecrets];
		redact = redactor(known);
		const job = redactingContext(ctx, (text) => redact(text));

		const [app] = await db
			.select()
			.from(apps)
			.where(eq(apps.id, input.appId))
			.limit(1);
		if (!app) throw new AppError("APP_NOT_FOUND");
		const manifest = await getAppManifest(app);
		executor = await getExecutor(await getAppServer(app));
		const exec = executor;
		workDir = newWorkDir("cloud-export");
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
		const opened = await driver.open(provider, config, "export", {
			target,
			publicUrl: await publicUrl(app),
			inputs: input.inputs,
		});
		const scrub = () => redactor([...known, ...opened.secrets()]);
		redact = (text) => scrub()(text);
		job.event("cloud_sync.opened", {
			project: opened.project,
			region: opened.region,
			product: provider.id,
			version: opened.version,
		});
		// The project may have changed since the preflight: nothing is
		// written unless it is still empty.
		if (!opened.assertEmpty) {
			throw internalError(`Driver ${provider.id} cannot check emptiness`);
		}
		await opened.assertEmpty();
		job.event("cloud_sync.export_empty", { project: opened.project });
		writing = opened.project;
		await opened.prepare(input.parts);
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
			partEvent: "cloud_sync.export_part",
		});
		await finishSync(input.syncId, "success", summary);
		job.event("cloud_sync.export_done", {
			project: opened.project,
			app: app.name,
		});
		return { success: true };
	} catch (error) {
		const safe = redactError(error, redact);
		if (writing) {
			// The project is no longer empty: a new export is refused until
			// the owner resets it.
			summary.notes = [
				...(summary.notes ?? []),
				{ code: "CLOUD_NOTE_EXPORT_PARTIAL", params: { project: writing } },
			];
		}
		await finishSync(input.syncId, "failed", summary).catch(() => undefined);
		return { success: false, error: safe };
	} finally {
		if (executor && workDir) {
			await executor.exec(removeWorkDirCommand(workDir)).catch(() => undefined);
			await ctx.setWorkDir?.(null);
		}
		executor?.close();
	}
}
