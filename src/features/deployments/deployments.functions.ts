import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { assertCanCancelJob } from "#/features/apps/app-jobs.server.ts";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { getDeployment } from "#/features/servers/servers.server.ts";
import { audit } from "#/server/services/audit.ts";
import { cancelJob } from "./deployments.server";
import { listJobs } from "./jobs.server";
import { JobFiltersSchema } from "./schema";

export const listJobsFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => JobFiltersSchema.parse(data ?? {}))
	.middleware([requirePermission("server.view")])
	.handler(async ({ context, data }) => listJobs(context.actor, data));

/**
 * Cancel a running job (app jobs: app.deploy; server jobs: server.manage): its current command is killed and the
 * job's failure path runs (services it stopped are started again).
 */
export const cancelJobFn = createServerFn({ method: "POST" })
	.validator((deploymentId: string) => z.guid().parse(deploymentId))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) => {
		const job = await getDeployment(context.actor, data);
		await assertCanCancelJob(context.actor, job);
		const result = await cancelJob(data);
		if (result.cancelled) {
			audit({
				actor: context.actor,
				action: "job.cancel",
				targetType: "deployment",
				targetId: data,
			});
		}
		return result;
	});
