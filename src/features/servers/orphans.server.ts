import { eq } from "drizzle-orm";
import { jobTitle } from "#/config/job-titles.ts";
import { hostPaths } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { servers } from "#/db/schema/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess } from "#/features/auth/access.ts";
import { startJob } from "#/features/deployments/deployments.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import {
	composeDownCommand,
	type OrphanEntry,
	orphanScanScript,
	parseOrphanScan,
	removeAppFolderCommand,
} from "#/server/services/apps/commands.ts";
import { audit } from "#/server/services/audit.ts";
import { AppError, commandError } from "#/utils/error.ts";
import { unknownWipePhrase } from "./schema";
import { getExecutor } from "./servers.server";

async function ownedServer(actor: Actor, serverId: string) {
	const [server] = await db
		.select()
		.from(servers)
		.where(eq(servers.id, serverId))
		.limit(1);
	return assertCanAccess(actor, server, "server.manage", "SERVER_NOT_FOUND");
}

async function knownFolders(serverId: string): Promise<Set<string>> {
	const rows = await db
		.select({ folder: apps.folder })
		.from(apps)
		.where(eq(apps.serverId, serverId));
	return new Set(rows.map((row) => row.folder));
}

/**
 * App data left on a server without an app row (deleted without wiping,
 * or a failed first deploy): folders and compose projects/volumes.
 */
export async function listOrphans(
	actor: Actor,
	serverId: string,
): Promise<OrphanEntry[]> {
	const server = await ownedServer(actor, serverId);
	if (server.status !== "ready") return [];
	const executor = await getExecutor(server);
	try {
		const result = await executor.exec(orphanScanScript(hostPaths().apps));
		return parseOrphanScan(
			result.stdout,
			await knownFolders(serverId),
			await requireInstanceId(),
		);
	} finally {
		executor.close();
	}
}

/** Remove an orphan's containers, volumes and folder (job). */
export async function wipeOrphan(
	actor: Actor,
	serverId: string,
	folder: string,
	confirmName: string,
	/**
	 * Instance admins only: also wipe data with no recorded owner, typed
	 * as `wipe <folder>` (never data another instance owns).
	 */
	forceUnknown = false,
): Promise<{ deploymentId: string }> {
	const server = await ownedServer(actor, serverId);
	if (forceUnknown) assertCanAccess(actor, "instance.manage");
	const expected = forceUnknown ? unknownWipePhrase(folder) : folder;
	if (confirmName.trim() !== expected) throw new AppError("APP_NAME_MISMATCH");
	const allowed = (owner: OrphanEntry["owner"]) =>
		owner === "self" || (forceUnknown && owner === "unknown");
	if ((await knownFolders(serverId)).has(folder))
		throw new AppError("APP_NAME_MISMATCH");
	const instanceId = await requireInstanceId();
	// Refuse up front (the job scans again right before removing anything).
	const precheck = await getExecutor(server);
	try {
		const scan = await precheck.exec(orphanScanScript(hostPaths().apps));
		const entry = parseOrphanScan(
			scan.stdout,
			await knownFolders(serverId),
			instanceId,
		).find((item) => item.folder === folder);
		if (!entry) throw new AppError("APP_NAME_MISMATCH");
		if (!allowed(entry.owner)) throw new AppError("ORPHAN_FOREIGN");
		if (entry.running > 0)
			throw new AppError("ORPHAN_RUNNING", { count: entry.running });
	} finally {
		precheck.close();
	}
	const location = { folder, appRoot: `${hostPaths().apps}/${folder}` };
	audit({
		actor,
		action: "server.orphan.wipe",
		targetType: "server",
		targetId: serverId,
		meta: { folder, unknownOwner: forceUnknown },
	});
	return startJob(
		{
			actor,
			serverId,
			type: "orphan_wipe",
			title: jobTitle("orphan_wipe", { folder }),
		},
		async (ctx) => {
			const executor = await getExecutor(server);
			try {
				// Re-scan inside the job: only wipe what is still an orphan
				// Nitrobase created (folder under the apps root or labelled resources).
				const scan = await executor.exec(orphanScanScript(hostPaths().apps));
				const current = parseOrphanScan(
					scan.stdout,
					await knownFolders(serverId),
					instanceId,
				).find((entry) => entry.folder === folder);
				if (!current) {
					return {
						success: false,
						error: new AppError("ORPHAN_GONE", { folder }),
					};
				}
				// Never wipe what another panel (or nobody known) owns, nor
				// anything still running.
				if (!allowed(current.owner)) {
					return { success: false, error: new AppError("ORPHAN_FOREIGN") };
				}
				if (current.running > 0) {
					return {
						success: false,
						error: new AppError("ORPHAN_RUNNING", { count: current.running }),
					};
				}
				if (current.containers > 0 || current.volumes.length > 0) {
					ctx.event("orphan.removing", { folder });
					const down = await executor.exec(composeDownCommand(location, true), {
						onStdout: ctx.log,
						onStderr: ctx.log,
					});
					if (down.exitCode !== 0) {
						throw commandError("COMPOSE_DOWN_FAILED", down.stderr);
					}
				}
				if (current.hasFolder) {
					ctx.event("teardown.folder", { path: location.appRoot });
					const rm = await executor.exec(removeAppFolderCommand(location));
					if (rm.exitCode !== 0) {
						throw commandError("APP_FOLDER_REMOVE_FAILED", rm.stderr);
					}
				}
				ctx.event("orphan.wiped", { folder });
				return { success: true };
			} catch (error) {
				return { success: false, error };
			} finally {
				executor.close();
			}
		},
	);
}
