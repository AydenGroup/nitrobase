import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { jobTitle } from "#/config/job-titles.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { servers } from "#/db/schema/server.ts";
import { startAppJob } from "#/features/apps/app-jobs.server.ts";
import { getAppRow } from "#/features/apps/apps.server.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import type { Actor } from "#/features/auth/access.ts";
import { getDestinationRow } from "#/features/backups/destinations.server.ts";
import { backupFirstStep } from "#/features/backups/jobs.server.ts";
import { runRestore } from "#/features/backups/restore.server.ts";
import type { BackupRow } from "#/features/backups/schema.ts";
import {
	type JobContext,
	type JobOutcome,
	waitForJob,
} from "#/features/deployments/deployments.server.ts";
import { sleep } from "#/libs/async.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import {
	type AppUpdateResult,
	decideRollback,
	type RollbackDecision,
	windowOpen,
} from "#/server/services/app-updates/policy.ts";
import { audit } from "#/server/services/audit.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import { emitEvent } from "#/server/services/events/bus.ts";
import { AppError, coded } from "#/utils/error.ts";
import {
	autoUpdateActor,
	driverFor,
	dueAutoUpdates,
	getUpdateRow,
	markAutoAttempted,
	recordUpdateResult,
} from "./app-updates.server";
import type { BatchItemStatus, UpdateBatchView } from "./schema";

/**
 * One-click, bulk and automatic app updates (R4 M4). An update is the
 * "Change version" deploy (or a Git build of the branch tip) with a backup
 * first (default on), and an automatic rollback when the deploy or its
 * health check fails: deploy the previous version again, or restore the
 * backup when the source says new versions migrate data irreversibly
 * (template.toml `[updates].rollback`, database engine registry).
 */

type Trigger = "manual" | "bulk" | "auto";

async function freshApp(appId: string): Promise<AppRow | null> {
	const [row] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	return row ?? null;
}

async function rollBack(
	actor: Actor,
	decision: RollbackDecision,
	previous: AppRow,
	backup: BackupRow | null,
	redeploy: (ctx: JobContext) => Promise<JobOutcome>,
	ctx: JobContext,
): Promise<boolean> {
	if (decision.action === "redeploy") {
		ctx.event("update.rollback_redeploy", { version: previous.version });
		return (await redeploy(ctx)).success;
	}
	if (decision.action === "restore" && backup) {
		ctx.event("update.rollback_restore");
		const destination = await getDestinationRow(actor, backup.destinationId);
		const outcome = await runRestore(
			{ backup, destination, appId: previous.id, clone: false },
			ctx,
		);
		return outcome.success;
	}
	return false;
}

export async function startAppUpdate(
	actor: Actor,
	input: {
		appId: string;
		version?: string;
		backupFirst: boolean;
		trigger: Trigger;
	},
): Promise<{ deploymentId: string }> {
	// Gate: app.deploy (a database row needs database.manage).
	const app = await getAppRow(actor, input.appId, "app.deploy");
	const { manifest, driver } = await driverFor(app);
	if (!driver) throw new AppError("APP_UPDATE_UNSUPPORTED");
	const target = input.version ?? (await getUpdateRow(app.id))?.latestVersion;
	if (!target) throw new AppError("APP_UPDATE_NONE");
	await driver.assertTarget?.(app, target, manifest);
	const mode = driver.rollback(app, manifest);
	// Automatic updates always back up (nobody is watching).
	const backupFirst = input.backupFirst || input.trigger === "auto";
	const first = backupFirst ? await backupFirstStep(actor, app) : null;
	const from = driver.current(app);
	audit({
		actor,
		action: "app.update",
		targetType: "app",
		targetId: app.id,
		meta: { from, to: target, trigger: input.trigger, backupFirst },
	});
	const { deploymentId } = await startAppJob(
		app,
		actor,
		"app_update",
		jobTitle("app_update", { app: app.name, version: target }),
		async (ctx) => {
			let backup: BackupRow | null = null;
			if (first) backup = await first(ctx);
			const outcome = await driver.apply(app, target, ctx);
			if (outcome.success) {
				await recordUpdateResult(
					app.id,
					{ lastResult: "succeeded", lastDeploymentId: ctx.deploymentId },
					target,
				);
				return outcome;
			}
			const after = await freshApp(app.id);
			const decision = decideRollback({
				mode,
				appTouched: after?.status === "error",
				backupTaken: !!backup,
			});
			let result: AppUpdateResult = "failed";
			if (decision.action === "none") {
				ctx.event("update.stopped_early");
			} else if (decision.action === "manual") {
				ctx.event(
					decision.reason === "no_backup"
						? "update.no_rollback_backup"
						: "update.no_rollback_manual",
				);
			} else {
				const rolledBack = await rollBack(
					actor,
					decision,
					app,
					backup,
					(job) => driver.redeploy(app, job),
					ctx,
				).catch((error) => {
					ctx.event("update.rollback_error", {
						error: { $error: errorInfoOf(error) },
					});
					return false;
				});
				result = rolledBack ? "rolled_back" : "failed";
				if (rolledBack) {
					ctx.event("update.rolled_back", { app: app.name, version: from });
				} else {
					ctx.event("update.rollback_failed");
				}
			}
			await recordUpdateResult(
				app.id,
				{ lastResult: result, lastDeploymentId: ctx.deploymentId },
				null,
			);
			emitEvent({
				id:
					result === "rolled_back"
						? "app.update_rolled_back"
						: "app.update_failed",
				teamId: app.teamId,
				subject: `${app.id}:${target}`,
				serverId: app.serverId,
				appId: app.id,
				params: {
					target: app.name,
					from,
					to: target,
					error: outcome.error ? { $error: errorInfoOf(outcome.error) } : "",
				},
			});
			const reason = outcome.error ?? new AppError("APP_UPDATE_FAILED");
			return {
				success: false,
				error:
					result === "rolled_back"
						? new AppError("APP_UPDATE_ROLLED_BACK", {
								version: target,
								reason: { $error: errorInfoOf(reason) },
							})
						: reason,
			};
		},
	);
	return { deploymentId };
}

// ---------------------------------------------------------------------------
// Bulk and automatic updates: a queue per server (one update at a time,
// waiting for the server's other jobs), in memory (single instance).

interface BatchItem {
	appId: string;
	appName: string;
	serverId: string;
	serverName: string;
	from: string;
	to: string;
	status: BatchItemStatus;
	deploymentId: string | null;
	error: ErrorInfo | null;
}

interface Batch {
	id: string;
	teamId: string;
	trigger: "bulk" | "auto";
	createdAt: Date;
	finishedAt: Date | null;
	/** Automatic updates stop starting new ones after the window. */
	deadline: Date | null;
	items: BatchItem[];
}

const globalBatches = globalThis as typeof globalThis & {
	__nitrobaseUpdateBatches?: Map<string, Batch>;
};
globalBatches.__nitrobaseUpdateBatches ??= new Map();
const batches = globalBatches.__nitrobaseUpdateBatches;

function pruneBatches(): void {
	const kept = getConfig().APP_UPDATE_BATCHES_KEPT;
	const finished = [...batches.values()]
		.filter((batch) => batch.finishedAt)
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
	for (const batch of finished.slice(kept)) batches.delete(batch.id);
}

/** Start when the server is free (its lock), up to the queue wait. */
async function startWhenIdle(
	start: () => Promise<{ deploymentId: string }>,
): Promise<{ deploymentId: string }> {
	const deadline = Date.now() + getConfig().APP_UPDATE_QUEUE_MAX_WAIT_MS;
	for (;;) {
		try {
			return await start();
		} catch (error) {
			const busy =
				error instanceof AppError &&
				(error.code === "SERVER_BUSY" || error.code === "INSTANCE_UPGRADING");
			if (!busy || Date.now() > deadline) throw error;
			await sleep(getConfig().APP_UPDATE_RETRY_MS);
		}
	}
}

async function runItem(
	actor: Actor,
	batch: Batch,
	item: BatchItem,
	backupFirst: boolean,
): Promise<void> {
	if (batch.deadline && Date.now() > batch.deadline.getTime()) {
		item.status = "skipped";
		item.error = coded("APP_UPDATE_WINDOW_CLOSED");
		return;
	}
	try {
		if (batch.trigger === "auto") await markAutoAttempted(item.appId, item.to);
		const { deploymentId } = await startWhenIdle(() =>
			startAppUpdate(actor, {
				appId: item.appId,
				version: item.to,
				backupFirst,
				trigger: batch.trigger,
			}),
		);
		item.status = "running";
		item.deploymentId = deploymentId;
		const status = await waitForJob(
			deploymentId,
			getConfig().APP_UPDATE_JOB_POLL_MS,
		);
		const row = await getUpdateRow(item.appId);
		item.status =
			row?.lastDeploymentId === deploymentId && row.lastResult
				? row.lastResult
				: status === "success"
					? "succeeded"
					: "failed";
	} catch (error) {
		item.status = "failed";
		item.error = errorInfoOf(error);
	}
}

function runBatch(actor: Actor, batch: Batch, backupFirst: boolean): void {
	const byServer = new Map<string, BatchItem[]>();
	for (const item of batch.items) {
		if (item.status !== "queued") continue;
		byServer.set(item.serverId, [...(byServer.get(item.serverId) ?? []), item]);
	}
	void Promise.all(
		[...byServer.values()].map(async (queue) => {
			for (const item of queue) await runItem(actor, batch, item, backupFirst);
		}),
	).finally(() => {
		batch.finishedAt = new Date();
		pruneBatches();
	});
}

async function serverNames(serverIds: string[]): Promise<Map<string, string>> {
	const ids = [...new Set(serverIds)];
	const rows = ids.length
		? await db
				.select({ id: servers.id, name: servers.name })
				.from(servers)
				.where(inArray(servers.id, ids))
		: [];
	return new Map(rows.map((row) => [row.id, row.name]));
}

async function batchItem(
	actor: Actor,
	appId: string,
	names: Map<string, string>,
): Promise<BatchItem> {
	const app = await getAppRow(actor, appId, "app.deploy");
	const { driver } = await driverFor(app);
	const row = await getUpdateRow(app.id);
	const item: BatchItem = {
		appId: app.id,
		appName: app.name,
		serverId: app.serverId,
		serverName: names.get(app.serverId) ?? "",
		from: driver?.current(app) ?? app.version,
		to: row?.latestVersion ?? "",
		status: "queued",
		deploymentId: null,
		error: null,
	};
	if (!driver || !row?.latestVersion) {
		item.status = "skipped";
		item.error = coded("APP_UPDATE_NONE");
	}
	return item;
}

export async function startUpdateBatch(
	actor: Actor,
	input: { appIds: string[]; backupFirst: boolean },
): Promise<UpdateBatchView> {
	const max = getConfig().APP_UPDATE_BATCH_MAX;
	const ids = [...new Set(input.appIds)];
	if (ids.length > max)
		throw new AppError("APP_UPDATE_BATCH_TOO_LARGE", { max });
	const rows = await db
		.select({ serverId: apps.serverId })
		.from(apps)
		.where(inArray(apps.id, ids));
	const names = await serverNames(rows.map((row) => row.serverId));
	const items: BatchItem[] = [];
	// Every app is checked (team + permission) before anything starts.
	for (const id of ids) items.push(await batchItem(actor, id, names));
	const batch: Batch = {
		id: randomUUID(),
		teamId: actor.teamId,
		trigger: "bulk",
		createdAt: new Date(),
		finishedAt: null,
		deadline: null,
		items,
	};
	batches.set(batch.id, batch);
	audit({
		actor,
		action: "app.update_bulk",
		meta: { apps: items.filter((item) => item.status === "queued").length },
	});
	runBatch(actor, batch, input.backupFirst);
	return batchView(batch);
}

function batchView(batch: Batch): UpdateBatchView {
	return {
		id: batch.id,
		trigger: batch.trigger,
		createdAt: batch.createdAt.toISOString(),
		finishedAt: batch.finishedAt?.toISOString() ?? null,
		items: batch.items.map(({ serverId: _server, ...item }) => ({ ...item })),
	};
}

export function getUpdateBatch(actor: Actor, id: string): UpdateBatchView {
	const batch = batches.get(id);
	if (!batch || batch.teamId !== actor.teamId) {
		throw new AppError("APP_UPDATE_BATCH_NOT_FOUND");
	}
	return batchView(batch);
}

/**
 * Maintenance window: apps whose policy allows their available update,
 * one batch per team, started now and stopping new updates when the
 * window closes.
 */
export async function runAutoUpdates(start: Date): Promise<void> {
	const config = getConfig();
	if (!windowOpen(start, new Date(), config.APP_AUTO_UPDATE_WINDOW_MINUTES)) {
		return;
	}
	const due = await dueAutoUpdates();
	const byTeam = new Map<string, typeof due>();
	for (const entry of due) {
		byTeam.set(entry.app.teamId, [
			...(byTeam.get(entry.app.teamId) ?? []),
			entry,
		]);
	}
	const names = await serverNames(due.map(({ app }) => app.serverId));
	for (const [teamId, entries] of byTeam) {
		const items: BatchItem[] = [];
		for (const { app, update } of entries) {
			const { driver } = await driverFor(app).catch(() => ({ driver: null }));
			items.push({
				appId: app.id,
				appName: app.name,
				serverId: app.serverId,
				serverName: names.get(app.serverId) ?? "",
				from: driver?.current(app) ?? app.version,
				to: update.latestVersion ?? "",
				status: "queued",
				deploymentId: null,
				error: null,
			});
		}
		const batch: Batch = {
			id: randomUUID(),
			teamId,
			trigger: "auto",
			createdAt: start,
			finishedAt: null,
			deadline: new Date(
				start.getTime() + config.APP_AUTO_UPDATE_WINDOW_MINUTES * 60_000,
			),
			items,
		};
		batches.set(batch.id, batch);
		// Each update runs as its app's owner (team system actor).
		runBatchPerApp(
			batch,
			entries.map(({ app }) => app),
		);
	}
}

/** Automatic batches: every app's update runs with its own team actor. */
function runBatchPerApp(batch: Batch, rows: AppRow[]): void {
	const actors = new Map(rows.map((app) => [app.id, autoUpdateActor(app)]));
	const byServer = new Map<string, BatchItem[]>();
	for (const item of batch.items) {
		byServer.set(item.serverId, [...(byServer.get(item.serverId) ?? []), item]);
	}
	void Promise.all(
		[...byServer.values()].map(async (queue) => {
			for (const item of queue) {
				const actor = actors.get(item.appId);
				if (actor) await runItem(actor, batch, item, true);
			}
		}),
	).finally(() => {
		batch.finishedAt = new Date();
		pruneBatches();
	});
}
