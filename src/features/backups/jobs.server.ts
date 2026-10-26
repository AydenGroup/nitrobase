import { and, desc, eq } from "drizzle-orm";
import { destinationCapabilities } from "#/config/backup-drivers.ts";
import { jobTitle } from "#/config/job-titles.ts";
import { db } from "#/db/index.ts";
import {
	backupDestinations,
	backupPolicies,
	backups,
} from "#/db/schema/backups.ts";
import { startAppJob } from "#/features/apps/app-jobs.server.ts";
import { getAppManifest, getAppRow } from "#/features/apps/apps.server.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import type { Actor } from "#/features/auth/access.ts";
import type { JobContext } from "#/features/deployments/deployments.server.ts";
import { audit } from "#/server/services/audit.ts";
import { AppError } from "#/utils/error.ts";
import { performAppBackup } from "./backups.server";
import { getDestinationRow } from "./destinations.server";
import type {
	AppBackupSummary,
	BackupRow,
	DestinationRow,
	PolicyRow,
} from "./schema";

export async function appPolicy(appId: string): Promise<PolicyRow | null> {
	const [policy] = await db
		.select()
		.from(backupPolicies)
		.where(eq(backupPolicies.appId, appId))
		.limit(1);
	return policy ?? null;
}

/**
 * Where an app's backups go when no destination is picked: its schedule's
 * destination, else the one of its last successful backup, else the
 * team's first destination.
 */
async function defaultDestinationId(
	actor: Actor,
	appId: string,
	policy: PolicyRow | null,
): Promise<string | null> {
	if (policy?.destinationId) return policy.destinationId;
	const [last] = await db
		.select({ destinationId: backups.destinationId })
		.from(backups)
		.where(and(eq(backups.appId, appId), eq(backups.status, "success")))
		.orderBy(desc(backups.createdAt))
		.limit(1);
	if (last) return last.destinationId;
	const [first] = await db
		.select({ id: backupDestinations.id })
		.from(backupDestinations)
		.where(eq(backupDestinations.teamId, actor.teamId))
		.orderBy(backupDestinations.createdAt)
		.limit(1);
	return first?.id ?? null;
}

async function resolveDestination(
	actor: Actor,
	app: AppRow,
	destinationId?: string,
): Promise<{ destination: DestinationRow; policy: PolicyRow | null }> {
	const policy = await appPolicy(app.id);
	const id =
		destinationId ?? (await defaultDestinationId(actor, app.id, policy));
	if (!id) throw new AppError("BACKUP_NO_DESTINATION");
	return { destination: await getDestinationRow(actor, id), policy };
}

/** `[backup] stop`: true, false, or the services stopped. */
function stopsServices(stop: boolean | string[]): boolean {
	return Array.isArray(stop) ? stop.length > 0 : stop;
}

/**
 * What the app page, the delete dialog and "Back up now" say about an
 * app's backups (last run, schedule, downtime).
 */
export async function getAppBackupSummary(
	actor: Actor,
	appId: string,
): Promise<AppBackupSummary> {
	const app = await getAppRow(actor, appId);
	const [policy, manifest, destinations, recent] = await Promise.all([
		appPolicy(app.id),
		getAppManifest(app).catch(() => null),
		db
			.select({
				id: backupDestinations.id,
				name: backupDestinations.name,
				type: backupDestinations.type,
			})
			.from(backupDestinations)
			.where(eq(backupDestinations.teamId, actor.teamId))
			.orderBy(backupDestinations.createdAt),
		db
			.select({
				status: backups.status,
				createdAt: backups.createdAt,
				finishedAt: backups.finishedAt,
				durationMs: backups.durationMs,
				destinationId: backups.destinationId,
				sizeBytes: backups.sizeBytes,
			})
			.from(backups)
			.where(eq(backups.appId, app.id))
			.orderBy(desc(backups.createdAt))
			.limit(20),
	]);
	const names = new Map(destinations.map((row) => [row.id, row.name]));
	const last = recent.find((row) => row.status !== "running") ?? null;
	const durations = recent
		.filter((row) => row.status === "success" && row.durationMs)
		.slice(0, 5)
		.map((row) => row.durationMs as number)
		.sort((a, b) => a - b);
	const median = durations.length
		? durations[Math.floor(durations.length / 2)]
		: null;
	return {
		destinations: destinations.map((row) => ({
			id: row.id,
			name: row.name,
			onServer: destinationCapabilities(row.type).onServer,
		})),
		defaultDestinationId: await defaultDestinationId(actor, app.id, policy),
		lastBackup: last
			? {
					at: last.finishedAt ?? last.createdAt,
					status: last.status,
					destinationName: names.get(last.destinationId) ?? null,
					sizeBytes: last.sizeBytes,
				}
			: null,
		schedule: policy ? { enabled: policy.enabled, cron: policy.cron } : null,
		stopsApp: stopsServices(manifest?.backup.stop ?? true),
		estimatedSeconds: median ? Math.max(1, Math.round(median / 1000)) : null,
	};
}

/** Manual or scheduled backup job of one app. */
export async function startAppBackup(
	actor: Actor,
	input: { appId: string; destinationId?: string },
	options: { trigger: "manual" | "schedule"; policyId?: string } = {
		trigger: "manual",
	},
): Promise<{ deploymentId: string }> {
	const app = await getAppRow(actor, input.appId);
	const { destination } = await resolveDestination(
		actor,
		app,
		input.destinationId,
	);
	audit({
		actor,
		action: "backup.create",
		targetType: "app",
		targetId: app.id,
		meta: { destinationId: destination.id, trigger: options.trigger },
	});
	return startAppJob(
		app,
		actor,
		"app_backup",
		jobTitle("app_backup", { app: app.name }),
		async (ctx) => {
			await performAppBackup(
				{
					appId: app.id,
					actor,
					destination,
					trigger: options.trigger,
					policyId: options.policyId,
					deploymentId: ctx.deploymentId,
				},
				ctx,
			);
			ctx.event("backup.done");
			return { success: true };
		},
	);
}

/**
 * "Back up first" for risky actions (version change, delete, secret
 * rotation): resolves the app's policy destination now (so a missing one
 * fails before the job starts) and returns a step for the job to run first.
 */
export async function backupFirstStep(
	actor: Actor,
	app: AppRow,
	destinationId?: string,
): Promise<(ctx: JobContext) => Promise<BackupRow>> {
	const { destination } = await resolveDestination(actor, app, destinationId);
	return async (ctx) => {
		ctx.event("backup.first", { app: app.name });
		return performAppBackup(
			{
				appId: app.id,
				actor,
				destination,
				trigger: "manual",
				deploymentId: ctx.deploymentId,
			},
			ctx,
		);
	};
}
