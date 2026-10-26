import { describe, expect, it, vi } from "vitest";
import type { JobContext } from "#/features/deployments/deployments.server.ts";
import {
	type InterruptedJob,
	type JobRecoveryHooks,
	recoverInterruptedJobs,
} from "./recovery";

const job = (overrides: Partial<InterruptedJob>): InterruptedJob => ({
	id: "d1",
	serverId: "s1",
	teamId: "t1",
	userId: "u1",
	appId: "a1",
	stoppedServices: null,
	workDir: null,
	...overrides,
});

describe("recoverInterruptedJobs", () => {
	it("notifies, removes work dirs, and restarts stopped services once per app", async () => {
		const calls: string[] = [];
		const hooks: JobRecoveryHooks = {
			onInterrupted: async (ids) => {
				calls.push(`interrupted ${ids.join(",")}`);
			},
			removeWorkDir: async ({ serverId, workDir }) => {
				calls.push(`rm ${serverId} ${workDir}`);
			},
			restartServices: async ({ appId, services }) => {
				calls.push(`start ${appId} ${services.join(",")}`);
			},
		};
		const start = vi.fn(
			async (
				params: { type: string; appId?: string },
				run: (ctx: JobContext) => Promise<{ success: boolean }>,
			) => {
				calls.push(`job ${params.type} ${params.appId}`);
				await run({ deploymentId: "r1", log: () => {}, event: () => {} });
				return { deploymentId: "r1" };
			},
		);
		await recoverInterruptedJobs(
			[
				job({
					id: "d1",
					stoppedServices: ["pocketbase"],
					workDir: "/etc/nitrobase/backup-work/backup-abc",
				}),
				job({ id: "d2", stoppedServices: ["worker", "pocketbase"] }),
				job({ id: "d3", appId: "a2" }),
				job({ id: "d4", appId: null, stoppedServices: ["x"] }),
			],
			[hooks],
			start as never,
		);
		expect(calls).toEqual([
			"interrupted d1,d2,d3,d4",
			"rm s1 /etc/nitrobase/backup-work/backup-abc",
			"job app_recover a1",
			"start a1 pocketbase,worker",
		]);
	});

	it("does nothing without interrupted jobs", async () => {
		const start = vi.fn();
		await recoverInterruptedJobs([], [], start as never);
		expect(start).not.toHaveBeenCalled();
	});
});
