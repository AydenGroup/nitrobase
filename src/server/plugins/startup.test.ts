import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const track = (name: string) =>
	vi.fn(() => {
		calls.push(name);
	});

vi.mock("nitro", () => ({ definePlugin: (fn: unknown) => fn }));
vi.mock("#/config/server.ts", () => ({ getConfig: () => ({}) }));
vi.mock("#/utils/env.ts", () => ({ assertServerEnv: () => {} }));
vi.mock("#/features/apps/domains.server.ts", () => ({
	registerPendingRoutes: track("pendingRoutes"),
}));
vi.mock("#/features/apps/recovery.server.ts", () => ({}));
vi.mock("#/features/apps/move.server.ts", () => ({}));
vi.mock("#/features/cloud-sync/import.server.ts", () => ({}));
vi.mock("#/features/backups/policies.server.ts", () => ({
	registerBackupSchedules: track("backupSchedules"),
	registerBackupWorkSweep: track("workSweep"),
}));
vi.mock("#/features/deployments/deployments.server.ts", () => ({
	recoverOrphanedJobs: vi.fn(async () => {
		calls.push("recover");
	}),
}));
vi.mock("#/features/monitoring/service.server.ts", () => ({
	registerMonitoring: track("monitoring"),
	stopMonitoring: vi.fn(async () => {}),
}));
vi.mock("#/features/servers/network-migration.server.ts", () => ({
	registerNetworkMigration: track("networkMigration"),
}));
vi.mock("#/features/notifications/dispatcher.server.ts", () => ({
	registerNotificationDispatcher: track("notifications"),
}));
vi.mock("#/features/notifications/scans.server.ts", () => ({
	registerPlatformSchedules: track("platformSchedules"),
}));
vi.mock("#/features/tasks/tasks.server.ts", () => ({
	registerTaskSchedules: track("taskSchedules"),
}));
vi.mock("#/server/services/scheduler.ts", () => ({ stopScheduler: () => {} }));
vi.mock("#/features/upgrade/upgrade.server.ts", () => ({}));
vi.mock("#/features/upgrade/release.server.ts", () => ({
	registerUpdateCheck: track("updateCheck"),
}));
vi.mock("#/features/app-updates/app-updates.server.ts", () => ({
	registerAppUpdateSchedules: track("appUpdates"),
}));
vi.mock("#/features/settings/instance.server.ts", () => ({
	ensurePanelAttached: vi.fn(async () => {}),
	applyPanelDomainFromEnv: vi.fn(async () => {}),
}));
let identity: "match" | "mismatch" = "match";
vi.mock("#/features/settings/instance-identity.server.ts", () => ({
	checkInstanceIdentity: vi.fn(async () =>
		identity === "match" ? null : "mismatch",
	),
}));

describe("startup plugin", () => {
	it("starts no background work when the database belongs to another instance", async () => {
		identity = "mismatch";
		vi.resetModules();
		const plugin = (await import("./startup")).default as unknown as (
			app: unknown,
		) => void;
		plugin({ hooks: { hook: () => {} } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toEqual([]);
		identity = "match";
		vi.resetModules();
	});

	it("registers notifications, platform schedules, the staging sweep, monitoring, the network migration, update checks, backup and task schedules at boot", async () => {
		const plugin = (await import("./startup")).default as unknown as (
			app: unknown,
		) => void;
		plugin({ hooks: { hook: () => {} } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toEqual([
			"pendingRoutes",
			"notifications",
			"platformSchedules",
			"workSweep",
			"monitoring",
			"networkMigration",
			"updateCheck",
			"appUpdates",
			"recover",
			"backupSchedules",
			"taskSchedules",
		]);
	});
});
