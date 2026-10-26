import { type JobTitle, jobTitle } from "#/config/job-titles.ts";
import type {
	JobContext,
	JobOutcome,
} from "#/features/deployments/deployments.server.ts";

/** Team and member a job runs for (an Actor fits). */
export interface JobOwner {
	teamId: string;
	userId: string | null;
}

type StartJob = (
	params: {
		actor: JobOwner;
		serverId: string;
		type: string;
		title: JobTitle;
		appId?: string;
	},
	run: (ctx: JobContext) => Promise<JobOutcome>,
) => Promise<{ deploymentId: string }>;

/**
 * Recovery hooks, registered by features that know how to undo a job's
 * side effects (#/features/apps/recovery.server.ts). Called when a job ends
 * with services still stopped, and at boot for jobs a dead process left.
 */
export interface JobRecoveryHooks {
	/** Start services a job stopped (runs inside a job holding the lock). */
	restartServices?(
		input: { appId: string; services: string[] },
		ctx: JobContext,
	): Promise<void>;
	/** Remove a staging folder left on a server. */
	removeWorkDir?(input: { serverId: string; workDir: string }): Promise<void>;
	/** Jobs that were interrupted (mark rows they own as failed...). */
	onInterrupted?(deploymentIds: string[]): Promise<void>;
	/**
	 * Running jobs of a dead process that this feature takes over instead
	 * of failing them (a panel upgrade is finished by the new panel). Called
	 * once at boot, before interrupted jobs are marked failed.
	 */
	adopt?(): Promise<string[]>;
}

export interface InterruptedJob {
	id: string;
	serverId: string;
	teamId: string;
	userId: string | null;
	appId: string | null;
	stoppedServices: string[] | null;
	workDir: string | null;
}

/**
 * Undo what interrupted jobs left behind: notify owners of related rows,
 * remove staging folders, and start one `app_recover` job per app whose
 * services a job had stopped.
 */
export async function recoverInterruptedJobs(
	jobs: InterruptedJob[],
	hooks: JobRecoveryHooks[],
	start: StartJob,
): Promise<void> {
	if (jobs.length === 0) return;
	for (const hook of hooks) {
		await hook.onInterrupted?.(jobs.map((job) => job.id));
	}
	for (const job of jobs) {
		if (!job.workDir) continue;
		for (const hook of hooks) {
			await hook
				.removeWorkDir?.({ serverId: job.serverId, workDir: job.workDir })
				.catch((error) =>
					console.error(`[jobs] could not remove ${job.workDir}`, error),
				);
		}
	}
	const byApp = new Map<string, InterruptedJob & { services: Set<string> }>();
	for (const job of jobs) {
		if (!job.appId || !job.stoppedServices?.length) continue;
		const entry = byApp.get(job.appId) ?? { ...job, services: new Set() };
		for (const service of job.stoppedServices) entry.services.add(service);
		byApp.set(job.appId, entry);
	}
	for (const [appId, entry] of byApp) {
		const services = [...entry.services];
		await start(
			{
				actor: { teamId: entry.teamId, userId: entry.userId },
				serverId: entry.serverId,
				appId,
				type: "app_recover",
				title: jobTitle("app_recover", { services: { $list: services } }),
			},
			async (ctx) => {
				ctx.event("recover.restarting", {
					job: entry.id,
					services: { $list: services },
				});
				for (const hook of hooks) {
					await hook.restartServices?.({ appId, services }, ctx);
				}
				ctx.event("recover.done");
				return { success: true };
			},
		).catch((error) =>
			console.error(`[jobs] could not start recovery for ${appId}`, error),
		);
	}
}
