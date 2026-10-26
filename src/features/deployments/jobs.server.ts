import { and, desc, eq, type SQL } from "drizzle-orm";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { deployments, servers } from "#/db/schema/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { recoverOrphanedJobs } from "./deployments.server";
import type { JobFilters, JobListItem } from "./schema";

/** Jobs across servers and apps for the Activity → Jobs page. */
export async function listJobs(
	actor: Actor,
	filters: JobFilters,
): Promise<JobListItem[]> {
	await recoverOrphanedJobs();
	const conditions: SQL[] = [eq(deployments.teamId, actor.teamId)];
	if (filters.type) conditions.push(eq(deployments.type, filters.type));
	if (filters.status) conditions.push(eq(deployments.status, filters.status));
	if (filters.serverId)
		conditions.push(eq(deployments.serverId, filters.serverId));
	if (filters.appId) conditions.push(eq(deployments.appId, filters.appId));
	return db
		.select({
			id: deployments.id,
			type: deployments.type,
			title: deployments.title,
			titleKey: deployments.titleKey,
			titleParams: deployments.titleParams,
			status: deployments.status,
			errorMessage: deployments.errorMessage,
			errorCode: deployments.errorCode,
			errorParams: deployments.errorParams,
			warningCount: deployments.warningCount,
			serverId: deployments.serverId,
			serverName: servers.name,
			appId: deployments.appId,
			appName: apps.name,
			createdAt: deployments.createdAt,
			updatedAt: deployments.updatedAt,
		})
		.from(deployments)
		.leftJoin(servers, eq(servers.id, deployments.serverId))
		.leftJoin(apps, eq(apps.id, deployments.appId))
		.where(and(...conditions))
		.orderBy(desc(deployments.createdAt))
		.limit(filters.limit);
}
