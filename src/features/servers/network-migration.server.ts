import { eq } from "drizzle-orm";
import { jobTitle } from "#/config/job-titles.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { servers } from "#/db/schema/server.ts";
import { settings } from "#/db/schema/settings.ts";
import { refreshAppFiles } from "#/features/apps/app-jobs.server.ts";
import { systemActor } from "#/features/auth/access.ts";
import {
	type JobContext,
	onServerIdle,
	startJob,
} from "#/features/deployments/deployments.server.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import {
	getExecutor,
	listReadyServers,
} from "#/features/servers/servers.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import {
	networkFileAction,
	networkRepairScript,
	networkStateScript,
	parseNetworkRepairs,
	parseNetworkStateLines,
	planNetworkRepairs,
} from "#/server/services/apps/networks.ts";
import { audit } from "#/server/services/audit.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import type { Executor } from "#/server/services/executor.ts";
import { assertServerOwned } from "#/server/services/server-setup.ts";
import { AppError, commandError } from "#/utils/error.ts";

/**
 * One-time migration of each server's proxy network (BUG-006). Apps
 * deployed before Nitrobase stopped naming the shared network in compose
 * files are registered there under their service names (`kong`,
 * `studio`...), so same-named services of two apps resolve each other.
 * Once per server (recorded in `settings`, run after boot or when the
 * server's job lock is next released), every app container of this
 * panel (owner label) registered there under another name than its own
 * is disconnected and connected again, which keeps only the container
 * name: through the proxy that container is unreachable for well under a
 * second, nothing restarts. The next deploy of each app rewrites its
 * compose file; monitoring repairs a container a stale compose file
 * re-registers meanwhile (`service.server.ts`).
 */

const recordKey = (serverId: string) => `migration.network-aliases.${serverId}`;

const migration = globalThis as typeof globalThis & {
	__nitrobaseNetworkMigration?: { registered: boolean; attempted: Set<string> };
};

async function isMigrated(serverId: string): Promise<boolean> {
	const [row] = await db
		.select({ key: settings.key })
		.from(settings)
		.where(eq(settings.key, recordKey(serverId)))
		.limit(1);
	return !!row;
}

async function recordMigrated(serverId: string, count: number): Promise<void> {
	const value = { plain: { at: new Date().toISOString(), containers: count } };
	await db
		.insert(settings)
		.values({ key: recordKey(serverId), value, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value, updatedAt: new Date() },
		});
}

/**
 * Rewrite the files of the server's apps whose deployed compose still
 * names a shared network (`refreshAppFiles`: re-render at the pinned
 * version and commit, upload; nothing restarts), so a later `up` from the
 * server's files (a single-service recreate, a cloud sync, a manual one)
 * does not register the service names again. Runs inside the migration
 * job, which holds the server lock: no job of any app on the server runs
 * meanwhile (that is the apps' lock). Only apps whose stored state is
 * what runs are rewritten: an app with changes waiting for a redeploy
 * (`needsRedeploy`, pending env) would get them half-applied on its next
 * single-service recreate, and an app in error, pending or busy may not
 * render at its stored version (e.g. a release the policy now refuses).
 * Those keep their files and show "Redeploy to finish the network fix"
 * (`networkFileAction`, `declaresSharedNetworks`) until redeployed.
 */
async function refreshFilesOf(
	executor: Executor,
	serverId: string,
	ctx: JobContext,
): Promise<void> {
	const rows = await db.select().from(apps).where(eq(apps.serverId, serverId));
	for (const app of rows) {
		const action = networkFileAction(app);
		if (action === "none") continue;
		if (action === "skip") {
			ctx.event("network_migration.files_skipped", { app: app.name });
			continue;
		}
		try {
			await refreshAppFiles(executor, app.id, ctx);
			ctx.event("network_migration.files_refreshed", { app: app.name });
		} catch (error) {
			ctx.event("network_migration.files_failed", {
				app: app.name,
				error: { $error: errorInfoOf(error) },
			});
		}
	}
}

/** The migration job of one server (no record is written on failures). */
async function startNetworkMigration(
	server: ServerRow,
): Promise<{ deploymentId: string }> {
	return startJob(
		{
			actor: systemActor(server.teamId),
			serverId: server.id,
			type: "network_migration",
			title: jobTitle("network_migration", { server: server.name }),
		},
		async (ctx) => {
			const network = getConfig().NITROBASE_NETWORK;
			const instanceId = await requireInstanceId();
			const executor = await getExecutor(server);
			try {
				// Another instance's server is left alone: nothing is written
				// or reconnected there.
				await assertServerOwned(executor, instanceId);
				await refreshFilesOf(executor, server.id, ctx);
				ctx.event("network_migration.scanning", { network });
				const scan = await executor.exec(
					networkStateScript(network, instanceId),
				);
				if (scan.exitCode !== 0) {
					throw commandError(
						"NETWORK_MIGRATION_FAILED",
						scan.stderr || scan.stdout,
					);
				}
				const repairs = planNetworkRepairs(
					parseNetworkStateLines(scan.stdout),
					{ instanceId, network },
				);
				const script = networkRepairScript(network, repairs);
				if (!script) {
					await recordMigrated(server.id, 0);
					ctx.event("network_migration.nothing");
					return { success: true };
				}
				ctx.event("network_migration.reconnecting", { count: repairs.length });
				const results = parseNetworkRepairs(
					(await executor.exec(script)).stdout,
				);
				const done = results.filter((result) => result.ok);
				for (const result of results) {
					ctx.event(
						result.ok
							? "network_migration.reconnected"
							: "network_migration.failed",
						{ container: result.container },
					);
				}
				audit({
					teamId: server.teamId,
					action: "server.network.repair",
					targetType: "server",
					targetId: server.id,
					meta: {
						containers: done.map((result) => result.container),
						trigger: "migration",
					},
					request: { ip: null, userAgent: null },
				});
				const failed = repairs.length - done.length;
				if (failed > 0) {
					return {
						success: false,
						error: new AppError("NETWORK_MIGRATION_INCOMPLETE", {
							count: failed,
						}),
					};
				}
				await recordMigrated(server.id, done.length);
				ctx.event("network_migration.done", { count: done.length });
				return { success: true };
			} finally {
				executor.close();
			}
		},
	);
}

/** Start the migration of `serverId` unless done, tried, or not Ready. */
async function maybeMigrate(serverId: string): Promise<void> {
	const state = migration.__nitrobaseNetworkMigration;
	if (!state || state.attempted.has(serverId)) return;
	const [server] = await db
		.select()
		.from(servers)
		.where(eq(servers.id, serverId))
		.limit(1);
	if (!server || server.status !== "ready") return;
	if (await isMigrated(serverId)) {
		state.attempted.add(serverId);
		return;
	}
	try {
		await startNetworkMigration(server);
		// One attempt per panel start: a failed one is retried at the next.
		state.attempted.add(serverId);
	} catch (error) {
		// Busy (or paused): retried when the server's lock is released.
		if (!(error instanceof AppError)) throw error;
	}
}

/**
 * Run the migration once per Ready server: shortly after boot, and when a
 * server's job lock is released (a server that was busy, or became Ready).
 */
export function registerNetworkMigration(): void {
	migration.__nitrobaseNetworkMigration ??= {
		registered: false,
		attempted: new Set(),
	};
	const state = migration.__nitrobaseNetworkMigration;
	if (state.registered) return;
	state.registered = true;
	onServerIdle((serverId) => maybeMigrate(serverId));
	setTimeout(() => {
		void listReadyServers()
			.then(async (rows) => {
				for (const server of rows) await maybeMigrate(server.id);
			})
			.catch((error) =>
				console.error("[network-migration] boot run failed", error),
			);
	}, getConfig().NETWORK_MIGRATION_BOOT_DELAY_MS).unref?.();
}
