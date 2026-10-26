import { describe, expect, it, vi } from "vitest";

const schedule = vi.fn();
const sweep = vi.fn(async (executor: { id: string }) => {
	if (executor.id === "bad") throw new Error("ssh down");
	return [] as string[];
});
const closed: string[] = [];

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));
vi.mock("#/db/index.ts", () => ({ db: {} }));
vi.mock("#/config/server.ts", () => ({
	getConfig: () => ({ BACKUP_WORK_SWEEP_CRON: "41 * * * *" }),
}));
vi.mock("#/server/services/scheduler.ts", () => ({
	schedule,
	unschedule: vi.fn(),
}));
vi.mock("#/features/servers/servers.server.ts", () => ({
	listReadyServers: async () => [{ id: "a" }, { id: "bad" }, { id: "c" }],
	getExecutor: async (server: { id: string }) => ({
		id: server.id,
		close: () => closed.push(server.id),
	}),
}));
vi.mock("./rclone.server", () => ({ sweepStaleWorkDirs: sweep }));
vi.mock("#/features/apps/apps.server.ts", () => ({}));
vi.mock("#/features/deployments/deployments.server.ts", () => ({}));
vi.mock("#/server/services/audit.ts", () => ({}));
vi.mock("./destinations.server", () => ({}));
vi.mock("./jobs.server", () => ({}));
vi.mock("./self-backup.server", () => ({}));

describe("registerBackupWorkSweep", () => {
	it("schedules the sweep on the config cron and sweeps every Ready server", async () => {
		const { registerBackupWorkSweep } = await import("./policies.server");
		registerBackupWorkSweep();
		expect(schedule).toHaveBeenCalledWith(
			"backup:work-sweep",
			"41 * * * *",
			expect.any(Function),
		);
		const task = schedule.mock.calls[0][2] as () => Promise<void>;
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await task();
		// One failing server doesn't stop the others; every executor closes.
		expect(sweep.mock.calls.map(([executor]) => executor.id)).toEqual([
			"a",
			"bad",
			"c",
		]);
		expect(closed).toEqual(["a", "bad", "c"]);
	}, 60_000);
});
