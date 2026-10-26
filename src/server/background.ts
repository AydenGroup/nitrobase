import { registerPendingRoutes } from "#/features/apps/domains.server.ts";
// Side effect: registers job recovery hooks (restart services, sweep work dirs).
import "#/features/apps/recovery.server.ts";
import "#/features/apps/move.server.ts";
// Side effect: cleans up after a cloud import the restart interrupted.
import "#/features/cloud-sync/import.server.ts";
// Side effect: adopts a panel upgrade job across the restart.
import "#/features/upgrade/upgrade.server.ts";
import { registerAppUpdateSchedules } from "#/features/app-updates/app-updates.server.ts";
import {
	registerBackupSchedules,
	registerBackupWorkSweep,
} from "#/features/backups/policies.server.ts";
import { recoverOrphanedJobs } from "#/features/deployments/deployments.server.ts";
import { registerMonitoring } from "#/features/monitoring/service.server.ts";
import { registerNotificationDispatcher } from "#/features/notifications/dispatcher.server.ts";
import { registerPlatformSchedules } from "#/features/notifications/scans.server.ts";
import { registerNetworkMigration } from "#/features/servers/network-migration.server.ts";
import {
	applyPanelDomainFromEnv,
	ensurePanelAttached,
} from "#/features/settings/instance.server.ts";
import { registerTaskSchedules } from "#/features/tasks/tasks.server.ts";
import { registerUpdateCheck } from "#/features/upgrade/release.server.ts";

/**
 * Everything that acts on servers without a user asking: pending routes,
 * notifications, platform schedules, the staging sweep, monitoring, job
 * recovery and backup schedules. Started at boot, or when an instance
 * admin resumes a paused instance (see instance-state.ts). Idempotent.
 */
export function startBackgroundWork(): void {
	registerPendingRoutes();
	registerNotificationDispatcher();
	registerPlatformSchedules();
	registerBackupWorkSweep();
	registerMonitoring();
	// Once per server: app containers off their service-name aliases (BUG-006).
	registerNetworkMigration();
	registerUpdateCheck();
	registerAppUpdateSchedules();
	// A recreated panel container must rejoin the panel route's network.
	void ensurePanelAttached()
		.then(() => applyPanelDomainFromEnv())
		.catch((error) =>
			console.error("[startup] panel route check failed", error),
		);
	recoverOrphanedJobs()
		.catch((error) => {
			// Retried lazily on first deployment access.
			console.error("[startup] failed to recover orphaned jobs", error);
		})
		// After recovery, so catch-up runs don't race interrupted jobs.
		.then(() => registerBackupSchedules())
		.catch((error) => {
			console.error("[startup] failed to register backup schedules", error);
		})
		.then(() => registerTaskSchedules())
		.catch((error) => {
			console.error("[startup] failed to register task schedules", error);
		});
}
