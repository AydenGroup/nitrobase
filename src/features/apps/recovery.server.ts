import { and, eq, inArray } from "drizzle-orm";
import { hostPaths } from "#/config/server.ts";
import { appStatuses, interruptibleStatuses } from "#/config/status.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { deployments, servers } from "#/db/schema/server.ts";
import { registerJobRecovery } from "#/features/deployments/deployments.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { composeStartServicesCommand } from "#/server/services/apps/commands.ts";
import {
	isRemovableWorkDir,
	removeWorkDirCommand,
} from "#/server/services/backup/archive.ts";
import { lastErrorColumns } from "#/server/services/error-info.ts";
import { isGitWorkDir } from "#/server/services/git/commands.ts";
import { AppError } from "#/utils/error.ts";
import { run, setStatus } from "./app-jobs.server";
import { appLocation, deployedServices, getAppServer } from "./apps.server";

/**
 * Recovery for app jobs (see JobRecoveryHooks): start services a job left
 * stopped, remove staging folders of interrupted jobs, and move apps stuck
 * in a busy status by a dead job to `error` so the UI tells the truth.
 */
registerJobRecovery("apps", {
	async restartServices({ appId, services }, ctx) {
		const [app] = await db
			.select()
			.from(apps)
			.where(eq(apps.id, appId))
			.limit(1);
		if (!app) return;
		const known = new Set(deployedServices(app));
		const targets = services.filter((service) => known.has(service));
		if (targets.length === 0) return;
		const executor = await getExecutor(await getAppServer(app));
		try {
			ctx.event("backup.restarting", { services: { $list: targets } });
			// One command: compose starts them in `depends_on` order (jobs
			// record them in stop order, dependents first).
			await run(
				executor,
				ctx,
				composeStartServicesCommand(appLocation(app), targets),
				(detail) =>
					new AppError("SERVICE_START_FAILED", {
						service: targets.join(", "),
						detail,
					}),
				{ quiet: true },
			);
			if (app.status !== "deleting") {
				await setStatus(app.id, {
					status: "running",
					...lastErrorColumns(null),
				});
			}
		} finally {
			executor.close();
		}
	},

	async removeWorkDir({ serverId, workDir }) {
		const paths = hostPaths();
		if (
			!isRemovableWorkDir(workDir, paths.backupWork) &&
			!isGitWorkDir(workDir, { apps: paths.apps, gitInspect: paths.gitInspect })
		) {
			return;
		}
		const [server] = await db
			.select()
			.from(servers)
			.where(eq(servers.id, serverId))
			.limit(1);
		if (!server) return;
		const executor = await getExecutor(server);
		try {
			await executor.exec(removeWorkDirCommand(workDir));
		} finally {
			executor.close();
		}
	},

	async onInterrupted(deploymentIds) {
		const rows = await db
			.select({ appId: deployments.appId })
			.from(deployments)
			.where(inArray(deployments.id, deploymentIds));
		const appIds = [
			...new Set(rows.flatMap((row) => (row.appId ? [row.appId] : []))),
		];
		if (appIds.length === 0) return;
		await db
			.update(apps)
			.set({
				status: "error",
				...lastErrorColumns(new AppError("APP_JOB_INTERRUPTED")),
				updatedAt: new Date(),
			})
			.where(
				and(
					inArray(apps.id, appIds),
					inArray(apps.status, interruptibleStatuses(appStatuses)),
				),
			);
	},
});
