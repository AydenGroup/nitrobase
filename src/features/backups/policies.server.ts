import { and, eq, isNull } from "drizzle-orm";
import { jobTitle } from "#/config/job-titles.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { backupPolicies } from "#/db/schema/backups.ts";
import { getAppRow } from "#/features/apps/apps.server.ts";
import { type Actor, systemActor } from "#/features/auth/access.ts";
import {
	isServerBusy,
	onServerIdle,
	startJob,
} from "#/features/deployments/deployments.server.ts";
import {
	getExecutor,
	listReadyServers,
} from "#/features/servers/servers.server.ts";
import {
	isValidCron,
	minIntervalMinutes,
	missedRunAt,
	nextRunAt,
} from "#/libs/cron.ts";
import { audit } from "#/server/services/audit.ts";
import { schedule, unschedule } from "#/server/services/scheduler.ts";
import { AppError } from "#/utils/error.ts";
import { getDestinationRow, pickServer } from "./destinations.server";
import { appPolicy, startAppBackup } from "./jobs.server";
import {
	listWorkDirs,
	removeWorkDirs,
	sweepStaleWorkDirs,
	type WorkDirView,
} from "./rclone.server";
import type { PolicyDTO, PolicyRow } from "./schema";
import { startPanelBackup } from "./self-backup.server";

const jobName = (policyId: string) => `backup:${policyId}`;

function toDTO(policy: PolicyRow): PolicyDTO {
	const next = policy.enabled ? nextRunAt(policy.cron) : null;
	return {
		id: policy.id,
		appId: policy.appId,
		serverId: policy.serverId,
		destinationId: policy.destinationId,
		cron: policy.cron,
		keepLast: policy.keepLast,
		keepDays: policy.keepDays,
		includeManual: policy.includeManual,
		enabled: policy.enabled,
		lastRunAt: policy.lastRunAt,
		nextRunAt: next,
	};
}

function assertSchedule(cron: string): void {
	if (!isValidCron(cron)) {
		throw new AppError("BACKUP_POLICY_CRON_INVALID", { cron });
	}
	const min = getConfig().BACKUP_MIN_INTERVAL_MINUTES;
	if (minIntervalMinutes(cron) < min) {
		throw new AppError("BACKUP_POLICY_TOO_FREQUENT", { minutes: min });
	}
}

export async function getAppPolicy(
	actor: Actor,
	appId: string,
): Promise<PolicyDTO | null> {
	await getAppRow(actor, appId);
	const policy = await appPolicy(appId);
	return policy ? toDTO(policy) : null;
}

export async function saveAppPolicy(
	actor: Actor,
	input: {
		appId: string;
		destinationId: string;
		cron: string;
		keepLast: number | null;
		keepDays: number | null;
		includeManual?: boolean;
		enabled: boolean;
	},
): Promise<PolicyDTO> {
	const app = await getAppRow(actor, input.appId);
	await getDestinationRow(actor, input.destinationId);
	assertSchedule(input.cron);
	const values = {
		destinationId: input.destinationId,
		cron: input.cron,
		keepLast: input.keepLast,
		keepDays: input.keepDays,
		includeManual: input.includeManual ?? false,
		enabled: input.enabled,
		updatedAt: new Date(),
	};
	const existing = await appPolicy(app.id);
	const [policy] = existing
		? await db
				.update(backupPolicies)
				.set(values)
				.where(eq(backupPolicies.id, existing.id))
				.returning()
		: await db
				.insert(backupPolicies)
				.values({
					...values,
					teamId: app.teamId,
					userId: actor.userId,
					appId: app.id,
				})
				.returning();
	refreshSchedule(policy);
	audit({
		actor,
		action: "backup.policy.save",
		targetType: "app",
		targetId: app.id,
		meta: { cron: input.cron, enabled: input.enabled },
	});
	return toDTO(policy);
}

/**
 * The Nitrobase self-backup policy: one per instance (instance admins only;
 * its destination and server belong to the team it was saved in).
 */
async function panelPolicyRow(): Promise<PolicyRow | null> {
	const [policy] = await db
		.select()
		.from(backupPolicies)
		.where(
			and(eq(backupPolicies.target, "panel"), isNull(backupPolicies.appId)),
		)
		.limit(1);
	return policy ?? null;
}

export async function getPanelPolicy(): Promise<PolicyDTO | null> {
	const policy = await panelPolicyRow();
	return policy ? toDTO(policy) : null;
}

export async function savePanelPolicy(
	actor: Actor,
	input: {
		serverId: string;
		destinationId: string;
		cron: string;
		keepLast: number | null;
		keepDays: number | null;
		enabled: boolean;
	},
): Promise<PolicyDTO> {
	await getDestinationRow(actor, input.destinationId);
	await pickServer(actor, input.serverId);
	assertSchedule(input.cron);
	const values = {
		serverId: input.serverId,
		destinationId: input.destinationId,
		cron: input.cron,
		keepLast: input.keepLast,
		keepDays: input.keepDays,
		enabled: input.enabled,
		updatedAt: new Date(),
	};
	const existing = await panelPolicyRow();
	const [policy] = existing
		? await db
				.update(backupPolicies)
				.set(values)
				.where(eq(backupPolicies.id, existing.id))
				.returning()
		: await db
				.insert(backupPolicies)
				.values({
					...values,
					teamId: actor.teamId,
					userId: actor.userId,
					target: "panel",
				})
				.returning();
	refreshSchedule(policy);
	audit({
		actor,
		action: "backup.panel_policy.save",
		meta: { cron: input.cron, enabled: input.enabled },
	});
	return toDTO(policy);
}

// ---------------------------------------------------------------------------
// Scheduler

interface Waiting {
	policyId: string;
	since: number;
}

// On globalThis so HMR keeps one queue and one idle listener.
const globalBackups = globalThis as typeof globalThis & {
	__nitrobaseBackupQueue?: {
		waiting: Map<string, Waiting[]>;
		listening: boolean;
	};
};
globalBackups.__nitrobaseBackupQueue ??= {
	waiting: new Map(),
	listening: false,
};
const queue = globalBackups.__nitrobaseBackupQueue;

function policyServerId(
	policy: PolicyRow,
	appServerId?: string,
): string | null {
	return policy.target === "panel" ? policy.serverId : (appServerId ?? null);
}

/**
 * Start a scheduled run as the policy owner. A busy server doesn't fail the
 * run: it waits for the server to go idle (up to BACKUP_BUSY_MAX_WAIT_MS).
 */
async function runScheduledPolicy(policyId: string): Promise<void> {
	const [policy] = await db
		.select()
		.from(backupPolicies)
		.where(eq(backupPolicies.id, policyId))
		.limit(1);
	if (!policy?.enabled) return;
	let serverId: string | null = null;
	try {
		// Scheduled runs act for the policy's team (attributed to its author).
		const actor = systemActor(policy.teamId, policy.userId, {
			instance: policy.target === "panel",
		});
		if (policy.target === "app" && policy.appId) {
			const app = await getAppRow(actor, policy.appId);
			serverId = policyServerId(policy, app.serverId);
			if (serverId && isServerBusy(serverId)) throw new AppError("SERVER_BUSY");
			await startAppBackup(
				actor,
				{ appId: policy.appId },
				{ trigger: "schedule", policyId: policy.id },
			);
		} else if (policy.target === "panel" && policy.serverId) {
			serverId = policy.serverId;
			if (isServerBusy(serverId)) throw new AppError("SERVER_BUSY");
			await startPanelBackup(
				actor,
				{ destinationId: policy.destinationId, serverId: policy.serverId },
				{ trigger: "schedule", policyId: policy.id },
			);
		} else {
			return;
		}
		await db
			.update(backupPolicies)
			.set({ lastRunAt: new Date() })
			.where(eq(backupPolicies.id, policy.id));
	} catch (error) {
		if (error instanceof AppError && error.code === "SERVER_BUSY" && serverId) {
			enqueue(serverId, policy.id);
			return;
		}
		console.error(`[backups] scheduled run of ${policy.id} failed`, error);
	}
}

function enqueue(serverId: string, policyId: string): void {
	const list = queue.waiting.get(serverId) ?? [];
	if (!list.some((item) => item.policyId === policyId)) {
		list.push({ policyId, since: Date.now() });
	}
	queue.waiting.set(serverId, list);
	if (!queue.listening) {
		queue.listening = true;
		onServerIdle(async (idleServerId) => {
			const waiting = queue.waiting.get(idleServerId);
			const next = waiting?.shift();
			if (!next) return;
			if (!waiting?.length) queue.waiting.delete(idleServerId);
			if (Date.now() - next.since > getConfig().BACKUP_BUSY_MAX_WAIT_MS) {
				console.error(
					`[backups] gave up on ${next.policyId}: server busy for too long`,
				);
				return;
			}
			await runScheduledPolicy(next.policyId);
		});
	}
}

function refreshSchedule(policy: PolicyRow): void {
	unschedule(jobName(policy.id));
	if (!policy.enabled) return;
	schedule(jobName(policy.id), policy.cron, () =>
		runScheduledPolicy(policy.id),
	);
}

/** Boot: register every enabled policy and catch up missed runs. */
export async function registerBackupSchedules(): Promise<void> {
	const policies = await db
		.select()
		.from(backupPolicies)
		.where(eq(backupPolicies.enabled, true));
	const now = new Date();
	for (const policy of policies) {
		try {
			refreshSchedule(policy);
			const missed = missedRunAt({
				cron: policy.cron,
				lastRunAt: policy.lastRunAt,
				createdAt: policy.createdAt,
				now,
			});
			if (missed && getConfig().BACKUP_CATCH_UP) {
				console.info(
					`[backups] catching up ${policy.id} (missed ${missed.toISOString()})`,
				);
				void runScheduledPolicy(policy.id);
			}
		} catch (error) {
			console.error(`[backups] could not schedule ${policy.id}`, error);
		}
	}
}

/**
 * Periodic staging sweep on every Ready server (config
 * BACKUP_WORK_SWEEP_CRON). Each backup/restore/download/test also sweeps its
 * server first; this covers servers that are not used again. Only folders
 * older than the longest job timeout go, so it never takes the job lock.
 */
/** Staging folders of a server, any age, for the manual cleanup dialog. */
export async function listServerWorkDirs(
	actor: Actor,
	serverId: string,
): Promise<WorkDirView[]> {
	const server = await pickServer(actor, serverId);
	const executor = await getExecutor(server);
	try {
		return await listWorkDirs(executor, server.id);
	} finally {
		executor.close();
	}
}

/**
 * "Clean up leftovers now": the automatic sweep (folders of finished jobs,
 * folders older than the longest job) plus the folders the owner chose in
 * the dialog, whatever their age (never one in use), as a job.
 */
export async function startWorkDirSweep(
	actor: Actor,
	serverId: string,
	paths: string[] = [],
): Promise<{ deploymentId: string }> {
	const server = await pickServer(actor, serverId);
	return startJob(
		{
			actor,
			serverId: server.id,
			type: "workdir_sweep",
			title: jobTitle("workdir_sweep", { server: server.name }),
		},
		async (ctx) => {
			const executor = await getExecutor(server);
			try {
				ctx.event("sweep.starting");
				const removed = await sweepStaleWorkDirs(executor, server.id);
				const chosen = await removeWorkDirs(
					executor,
					server.id,
					paths.filter((path) => !removed.includes(path)),
				);
				removed.push(...chosen.removed);
				for (const path of removed) ctx.event("sweep.removed", { path });
				for (const path of chosen.skipped) {
					ctx.event("sweep.kept", { path });
				}
				if (removed.length) {
					ctx.event("sweep.done", { count: removed.length });
				} else {
					ctx.event("sweep.nothing");
				}
				audit({
					actor,
					action: "server.workdir.sweep",
					targetType: "server",
					targetId: server.id,
					meta: { removed, trigger: "manual" },
				});
				return { success: true };
			} finally {
				executor.close();
			}
		},
	);
}

export function registerBackupWorkSweep(): void {
	schedule("backup:work-sweep", getConfig().BACKUP_WORK_SWEEP_CRON, sweepAll);
	// Once shortly after boot too: a panel that died mid-build may have left
	// a deploy key or build secrets in a build folder.
	setTimeout(
		() => void sweepAll().catch(() => {}),
		getConfig().WORK_SWEEP_BOOT_DELAY_MS,
	).unref?.();
}

async function sweepAll(): Promise<void> {
	for (const server of await listReadyServers()) {
		let executor: Awaited<ReturnType<typeof getExecutor>> | null = null;
		try {
			executor = await getExecutor(server);
			const removed = await sweepStaleWorkDirs(executor, server.id);
			if (removed.length) {
				console.info(
					`[backups] removed leftover staging on ${server.id}: ${removed.join(", ")}`,
				);
				audit({
					teamId: server.teamId,
					action: "server.workdir.sweep",
					targetType: "server",
					targetId: server.id,
					meta: { removed, trigger: "schedule" },
					request: { ip: null, userAgent: null },
				});
			}
		} catch (error) {
			console.warn(
				`[backups] staging sweep failed on ${server.id}:`,
				error instanceof Error ? error.message : error,
			);
		} finally {
			executor?.close();
		}
	}
}
