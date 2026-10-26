import { jobTitle } from "#/config/job-titles.ts";
import { getConfig } from "#/config/server.ts";
import { startAppJob } from "#/features/apps/app-jobs.server.ts";
import { appLocation } from "#/features/apps/apps.server.ts";
import type { Actor } from "#/features/auth/access.ts";
import type {
	JobContext,
	JobOutcome,
} from "#/features/deployments/deployments.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { audit } from "#/server/services/audit.ts";
import { ensureToolsImageCommand } from "#/server/services/backup/archive.ts";
import {
	checkStorageFiles,
	readStorageBackend,
	storageDatabaseTarget,
} from "#/server/services/supabase/storage-metadata.ts";
import { AppError, commandError } from "#/utils/error.ts";
import {
	requireDeployed,
	type SupabaseContext,
	supabaseContext,
	withExecutor,
} from "./supabase.server";

/**
 * On-demand "Repair storage metadata" (apps restored from an archive made
 * before backups kept extended attributes): the same check a restore runs,
 * as an app job (server lock, log, warnings). Only missing attributes are
 * set, so it is safe on a running app.
 */
export async function startStorageRepair(
	actor: Actor,
	appId: string,
): Promise<{ deploymentId: string }> {
	const ctx = await supabaseContext(actor, appId, "storage-repair");
	const storage = ctx.config.storage_files;
	if (!storage) {
		throw new AppError("STORAGE_FILES_UNSUPPORTED");
	}
	requireDeployed(ctx, ctx.config.db_service);
	requireDeployed(ctx, storage.service);
	// Not applicable (e.g. S3 backend): say so now instead of a no-op job.
	const backend = await withExecutor(ctx, (executor) =>
		readStorageBackend(executor, ctx.container(storage.service), storage, {
			timeoutMs: getConfig().SUPABASE_SQL_TIMEOUT_MS,
		}),
	);
	if (backend !== storage.backend_value) {
		throw new AppError("STORAGE_BACKEND_NOT_FILE", {
			backend: backend ?? "",
		});
	}
	audit({
		actor,
		action: "supabase.storage.repair",
		targetType: "app",
		targetId: ctx.app.id,
	});
	return startAppJob(
		ctx.app,
		actor,
		"supabase_storage_repair",
		jobTitle("supabase_storage_repair", { app: ctx.app.name }),
		(job) => runStorageRepair(ctx, job),
	);
}

async function runStorageRepair(
	ctx: SupabaseContext,
	job: JobContext,
): Promise<JobOutcome> {
	const storage = ctx.config.storage_files;
	if (!storage) {
		return { success: false, error: new AppError("STORAGE_FILES_UNSUPPORTED") };
	}
	const config = getConfig();
	const executor = await getExecutor(ctx.server);
	try {
		const tools = {
			image: config.BACKUP_TOOLS_IMAGE,
			baseImage: config.BACKUP_TOOLS_BASE_IMAGE,
		};
		const built = await executor.exec(ensureToolsImageCommand(tools), {
			timeoutMs: config.SUPABASE_STORAGE_REPAIR_TIMEOUT_MS,
			signal: job.signal,
		});
		if (built.exitCode !== 0) {
			throw commandError(
				"BACKUP_TOOLS_FAILED",
				built.stderr || built.stdout || `exit ${built.exitCode}`,
			);
		}
		await checkStorageFiles(
			{
				executor,
				toolsImage: tools.image,
				config: storage,
				values: ctx.values,
				location: appLocation(ctx.app),
				storageContainer: ctx.container(storage.service),
				database: storageDatabaseTarget(
					ctx.config,
					ctx.container,
					config.SUPABASE_SQL_TIMEOUT_MS,
				),
				batchSize: config.SUPABASE_STORAGE_REPAIR_BATCH,
				timeoutMs: config.SUPABASE_STORAGE_REPAIR_TIMEOUT_MS,
			},
			job,
		);
		return { success: true };
	} catch (error) {
		return { success: false, error };
	} finally {
		executor.close();
	}
}
