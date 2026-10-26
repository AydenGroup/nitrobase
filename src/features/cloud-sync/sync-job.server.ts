import { and, eq, inArray } from "drizzle-orm";
import {
	type CloudSyncProvider,
	partsFor,
	type SyncDirection,
	type SyncPart,
} from "#/config/cloud-sync.ts";
import type { JobLogEvent } from "#/config/job-log-events.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import type { apps } from "#/db/schema/apps.ts";
import { apps as appsTable } from "#/db/schema/apps.ts";
import {
	type CloudSyncSummary,
	cloudConnections,
	cloudSyncs,
} from "#/db/schema/cloud-sync.ts";
import { deployments } from "#/db/schema/server.ts";
import {
	appInputs,
	appLocation,
	containerName,
	getAppManifest,
	getAppServer,
	readEnvValues,
} from "#/features/apps/apps.server.ts";
import {
	type JobContext,
	registerJobRecovery,
} from "#/features/deployments/deployments.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import type { ErrorCode } from "#/libs/error-codes.ts";
import { composeLifecycleCommand } from "#/server/services/apps/commands.ts";
import { cloudSyncDriver } from "#/server/services/cloud-sync/drivers.ts";
import type {
	OpenedSync,
	StepFailure,
	SyncTarget,
} from "#/server/services/cloud-sync/types.ts";
import { type Executor, shellQuote } from "#/server/services/executor.ts";
import { AppError, commandError } from "#/utils/error.ts";
import { connectionConfig } from "./connections.server";

/** Refuse parts the provider cannot sync in `direction`. */
export function assertParts(
	provider: CloudSyncProvider,
	direction: SyncDirection,
	parts: SyncPart[],
) {
	const supported = partsFor(provider, direction);
	for (const part of parts) {
		if (!supported.includes(part)) {
			throw new AppError("CLOUD_SYNC_PART_UNSUPPORTED", { part });
		}
	}
}

/**
 * What import and export jobs share: the app as a `SyncTarget`, the step
 * loop (warnings, checkpoints, critical steps), the sync row's end and the
 * crash recovery of a step's leftovers.
 */

type AppRow = typeof apps.$inferSelect;

export const asAppError = (info: ErrorInfo) =>
	new AppError(info.code as ErrorCode, (info.params ?? {}) as never);

export async function finishSync(
	syncId: string,
	status: "success" | "failed",
	summary: CloudSyncSummary,
) {
	await db
		.update(cloudSyncs)
		.set({ status, summary, finishedAt: new Date() })
		.where(eq(cloudSyncs.id, syncId));
}

/** The app a sync step works on, through `exec` on its server. */
export function appSyncTarget(
	app: AppRow,
	pluginConfig: unknown,
	exec: Executor,
	options: {
		workDir: string;
		signal?: AbortSignal;
		/** Command output (omitted: not logged). */
		log?: (chunk: string) => void;
		redact: (text: string) => string;
		servicesStopped?: (services: string[]) => Promise<void>;
		servicesStarted?: (services: string[]) => Promise<void>;
	},
): SyncTarget {
	const timeoutMs = getConfig().CLOUD_SYNC_JOB_TIMEOUT_MS;
	const run = async (
		command: string,
		failure: StepFailure,
		runOptions: { input?: string | Buffer; quiet?: boolean } = {},
	) => {
		const log = runOptions.quiet ? undefined : options.log;
		const result = await exec.exec(command, {
			input: runOptions.input,
			timeoutMs,
			signal: options.signal,
			onStdout: log,
			onStderr: log,
		});
		if (result.exitCode !== 0) {
			const detail = options.redact(
				result.stderr || result.stdout || `exit ${result.exitCode}`,
			);
			throw typeof failure === "function"
				? failure(detail)
				: commandError(failure, detail);
		}
		return result.stdout;
	};
	const location = appLocation(app);
	return {
		executor: exec,
		workDir: options.workDir,
		appName: app.name,
		pluginConfig,
		values: { ...readEnvValues(app), ...appInputs(app).overrides },
		container: (service) => containerName(app.folder, service),
		run,
		compose: (args, failure) =>
			run(composeLifecycleCommand(location, args.map(shellQuote)), failure, {
				quiet: true,
			}),
		servicesStopped: async (services) => {
			await options.servicesStopped?.(services);
		},
		servicesStarted: async (services) => {
			await options.servicesStarted?.(services);
		},
	};
}

/** Job rollback state of a sync step (`deployments.rollback`). */
type CloudSyncRollback = {
	kind: "cloud_sync";
	provider: string;
	appId: string;
	syncId: string;
	/** The driver's own state (ids only). */
	state: Record<string, unknown>;
};

const cloudSyncRollback = (
	input: Omit<CloudSyncRollback, "kind">,
): CloudSyncRollback => ({ kind: "cloud_sync", ...input });

function isCloudSyncRollback(value: unknown): value is CloudSyncRollback {
	const row = value as Partial<CloudSyncRollback> | null;
	return (
		!!row &&
		row.kind === "cloud_sync" &&
		typeof row.provider === "string" &&
		typeof row.appId === "string" &&
		typeof row.state === "object"
	);
}

/** The connection of a sync row, when it still exists and parses. */
async function syncConnection(syncId: string) {
	const [row] = await db
		.select({ connection: cloudConnections })
		.from(cloudSyncs)
		.innerJoin(
			cloudConnections,
			eq(cloudConnections.id, cloudSyncs.connectionId),
		)
		.where(eq(cloudSyncs.id, syncId))
		.limit(1);
	if (!row) return undefined;
	try {
		const { provider, config } = connectionConfig(row.connection);
		return { provider, config };
	} catch {
		return undefined;
	}
}

/** After a panel restart: let the driver undo what the step left behind. */
async function recoverInterruptedSync(rollback: CloudSyncRollback) {
	const driver = cloudSyncDriver(rollback.provider);
	if (!driver?.recover) return;
	const [app] = await db
		.select()
		.from(appsTable)
		.where(eq(appsTable.id, rollback.appId))
		.limit(1);
	if (!app) return;
	const manifest = await getAppManifest(app);
	const executor = await getExecutor(await getAppServer(app));
	try {
		await driver.recover({
			state: rollback.state,
			target: appSyncTarget(app, manifest.plugin, executor, {
				workDir: "",
				redact: (text) => text,
			}),
			connection: await syncConnection(rollback.syncId),
		});
	} finally {
		executor.close();
	}
}

registerJobRecovery("cloud-sync", {
	async onInterrupted(deploymentIds) {
		// Their sync rows never finished: they were interrupted.
		await db
			.update(cloudSyncs)
			.set({ status: "failed", finishedAt: new Date() })
			.where(
				and(
					inArray(cloudSyncs.deploymentId, deploymentIds),
					eq(cloudSyncs.status, "running"),
				),
			);
		const rows = await db
			.select({ rollback: deployments.rollback })
			.from(deployments)
			.where(inArray(deployments.id, deploymentIds));
		for (const row of rows) {
			if (!isCloudSyncRollback(row.rollback)) continue;
			await recoverInterruptedSync(row.rollback).catch((error) =>
				console.error("[jobs] cloud sync recovery failed", error),
			);
		}
	},
});

/** A warning collector that also keeps each warning once in `summary`. */
function summaryWarner(
	job: JobContext,
	ctx: JobContext,
	summary: CloudSyncSummary,
) {
	summary.warnings ??= [];
	return async (warning: ErrorInfo) => {
		job.event("job.warning", { warning: { $error: warning } });
		await ctx.addWarnings?.(1);
		const entry = { code: warning.code ?? "", params: warning.params ?? {} };
		// Preflight already listed some (e.g. function secrets): once.
		const key = JSON.stringify(entry);
		if (!summary.warnings?.some((item) => JSON.stringify(item) === key)) {
			summary.warnings?.push(entry);
		}
	};
}

/** Run the driver's steps (critical ones as such, checkpoints recorded). */
export async function runSyncSteps(input: {
	ctx: JobContext;
	/** Redacting context. */
	job: JobContext;
	opened: OpenedSync;
	parts: SyncPart[];
	target: SyncTarget;
	summary: CloudSyncSummary;
	provider: string;
	appId: string;
	syncId: string;
	/** Log event announcing each part. */
	partEvent: Extract<JobLogEvent, "cloud_sync.part" | "cloud_sync.export_part">;
}): Promise<void> {
	const { ctx, job, summary } = input;
	const warn = summaryWarner(job, ctx, summary);
	for (const step of input.opened.steps(input.parts)) {
		if (step.part) job.event(input.partEvent, { part: step.part });
		const go = () =>
			step.run({
				job,
				target: input.target,
				parts: input.parts,
				summary,
				warn,
				checkpoint: async (state) => {
					await ctx.setRollback?.(
						state
							? cloudSyncRollback({
									provider: input.provider,
									appId: input.appId,
									syncId: input.syncId,
									state,
								})
							: null,
					);
				},
			});
		await (step.critical && ctx.critical
			? ctx.critical(step.critical, go)
			: go());
	}
}
