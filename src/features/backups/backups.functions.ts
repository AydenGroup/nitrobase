import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { schedulerClock } from "#/libs/cron.ts";
import { i18nMiddleware } from "#/libs/i18n.ts";
import { deleteBackup, listBackups } from "./backups.server";
import {
	createDestination,
	deleteDestination,
	listDestinations,
	testDestination,
	updateDestination,
} from "./destinations.server";
import { getAppBackupSummary, startAppBackup } from "./jobs.server";
import {
	getAppPolicy,
	getPanelPolicy,
	listServerWorkDirs,
	saveAppPolicy,
	savePanelPolicy,
	startWorkDirSweep,
} from "./policies.server";
import {
	restoreClonePreview,
	startRestore,
	startVerifyBackup,
} from "./restore.server";
import {
	BackupIdSchema,
	BackupListSchema,
	DestinationIdSchema,
	DestinationInputSchema,
	PanelPolicyInputSchema,
	PolicyInputSchema,
	RestoreSchema,
	RunBackupSchema,
	RunPanelBackupSchema,
	SweepWorkDirsSchema,
	TestDestinationSchema,
	UpdateDestinationSchema,
} from "./schema";
import { startPanelBackup } from "./self-backup.server";

// Destinations (credentials never leave the server: secrets come back masked)

export const listDestinationsFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("backup.view")])
	.handler(async ({ context }) => listDestinations(context.actor));

export const createDestinationFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("destination.manage")])
	.handler(async ({ context, data }) =>
		createDestination(
			context.actor,
			DestinationInputSchema(context.i18n).parse(data),
		),
	);

export const updateDestinationFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("destination.manage")])
	.handler(async ({ context, data }) => {
		await updateDestination(
			context.actor,
			UpdateDestinationSchema(context.i18n).parse(data),
		);
		return { success: true };
	});

export const deleteDestinationFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => DestinationIdSchema.parse(data))
	.middleware([requirePermission("destination.manage")])
	.handler(async ({ context, data }) => {
		await deleteDestination(context.actor, data.id);
		return { success: true };
	});

export const testDestinationFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => TestDestinationSchema.parse(data))
	.middleware([requirePermission("destination.manage")])
	.handler(async ({ context, data }) =>
		testDestination(context.actor, data.id, data.serverId),
	);

// Backups

export const listBackupsFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => BackupListSchema.parse(data ?? {}))
	.middleware([requirePermission("backup.view")])
	.handler(async ({ context, data }) => listBackups(context.actor, data));

export const runBackupFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => RunBackupSchema.parse(data))
	.middleware([requirePermission("backup.create")])
	.handler(async ({ context, data }) => startAppBackup(context.actor, data));

export const deleteBackupFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => BackupIdSchema.parse(data))
	.middleware([requirePermission("backup.delete")])
	.handler(async ({ context, data }) => {
		await deleteBackup(context.actor, data.id);
		return { success: true };
	});

/** Overwrite the app, or clone into a new app (audited). */
export const restoreBackupFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => RestoreSchema.parse(data))
	.middleware([requirePermission("backup.restore")])
	.handler(async ({ context, data }) => startRestore(context.actor, data));

/** Which values "restore as a new app" recomputes or keeps. */
export const restoreClonePreviewFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => BackupIdSchema.parse(data))
	.middleware([requirePermission("backup.restore")])
	.handler(async ({ context, data }) =>
		restoreClonePreview(context.actor, data.id),
	);

/** Download and check an archive (sha256 + manifest) without restoring. */
export const verifyBackupFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => BackupIdSchema.parse(data))
	.middleware([requirePermission("backup.create")])
	.handler(async ({ context, data }) =>
		startVerifyBackup(context.actor, data.id),
	);

// Policies

export const getAppPolicyFn = createServerFn({ method: "GET" })
	.validator((appId: string) => z.guid().parse(appId))
	.middleware([requirePermission("backup.view")])
	.handler(async ({ context, data }) => getAppPolicy(context.actor, data));

/**
 * The time zone schedules run in (this Nitrobase process): cron hours in
 * schedule editors are in this zone, not the viewer's.
 */
export const getSchedulerClockFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("backup.view")])
	.handler(async () => schedulerClock());

/** Last backup, schedule and downtime estimate of an app (dialogs, overview). */
export const getAppBackupSummaryFn = createServerFn({ method: "GET" })
	.validator((appId: string) => z.guid().parse(appId))
	.middleware([requirePermission("backup.view")])
	.handler(async ({ context, data }) =>
		getAppBackupSummary(context.actor, data),
	);

export const saveAppPolicyFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => PolicyInputSchema.parse(data))
	.middleware([requirePermission("backup.policy.manage")])
	.handler(async ({ context, data }) => saveAppPolicy(context.actor, data));

// Nitrobase self-backup

export const getPanelPolicyFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("instance.manage")])
	.handler(async () => getPanelPolicy());

export const savePanelPolicyFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => PanelPolicyInputSchema.parse(data))
	.middleware([requirePermission("instance.manage")])
	.handler(async ({ context, data }) => savePanelPolicy(context.actor, data));

export const runPanelBackupFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => RunPanelBackupSchema.parse(data))
	.middleware([requirePermission("instance.manage")])
	.handler(async ({ context, data }) => startPanelBackup(context.actor, data));

/** Backup staging folders on a server (any age), for the cleanup dialog. */
export const listWorkDirsFn = createServerFn({ method: "GET" })
	.validator((serverId: string) => z.guid().parse(serverId))
	.middleware([requirePermission("server.manage")])
	.handler(async ({ context, data }) =>
		listServerWorkDirs(context.actor, data),
	);

/** Remove leftover backup staging folders on a server now (as a job). */
export const sweepWorkDirsFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => SweepWorkDirsSchema.parse(data))
	.middleware([requirePermission("server.manage")])
	.handler(async ({ context, data }) =>
		startWorkDirSweep(context.actor, data.serverId, data.paths),
	);
