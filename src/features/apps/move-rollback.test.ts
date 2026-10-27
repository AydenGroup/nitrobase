import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A move that fails on the target starts again exactly the services that
 * ran on the source before it (compose ps), and an app stopped before
 * stays stopped with its status (follow-up of BUG-020: the rollback used a
 * bare `compose start` and always set `running`). `runMove` runs for real;
 * the backup, the target restore and the executors are fakes.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const state = vi.hoisted(() => ({
	/** Services `compose ps` reports running on the source before the move. */
	running: [] as string[],
	commands: [] as string[],
	status: "running" as string,
	patches: [] as Record<string, unknown>[],
	stopped: [] as string[],
	started: [] as string[],
}));

vi.mock("#/db/index.ts", () => ({
	db: {
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => [] }) }),
		}),
		update: () => ({
			set: () => ({ where: async () => {} }),
		}),
	},
}));

vi.mock("#/features/backups/backups.server.ts", () => ({
	runningServices: async () => state.running,
	performAppBackup: async () => ({ id: "backup-1" }),
}));
vi.mock("#/features/backups/destinations.server.ts", () => ({
	getDestinationRow: async () => ({}),
}));
vi.mock("#/features/backups/rclone.server.ts", () => ({
	newWorkDir: () => "/work",
	// The target side fails: the move rolls back.
	openRclone: async () => {
		throw new Error("target unreachable");
	},
}));
vi.mock("#/features/backups/restore.server.ts", () => ({
	applyArchiveState: async () => {},
	fetchArchive: async () => ({}),
	restoreData: () => async () => {},
}));
vi.mock("#/features/deployments/deployments.server.ts", () => ({
	consoleJobContext: () => ({}),
	redactingContext: (ctx: unknown) => ctx,
	registerJobRecovery: () => {},
	startJob: async () => ({ deploymentId: "dep-1" }),
}));
vi.mock("#/features/servers/servers.server.ts", () => ({
	getExecutor: async () => ({
		async exec(command: string) {
			state.commands.push(command);
			return { stdout: "", stderr: "", exitCode: 0 };
		},
		close() {},
	}),
	getServerRow: async () => ({}),
}));
vi.mock("#/server/services/audit.ts", () => ({ audit: () => {} }));

vi.mock("./app-jobs.server", () => ({
	logWarning: () => {},
	run: async (
		executor: { exec: (command: string) => Promise<{ stdout: string }> },
		_ctx: unknown,
		command: string,
	) => (await executor.exec(command)).stdout,
	runDeploy: async () => ({ success: false }),
	setStatus: async (_id: string, patch: Record<string, unknown>) => {
		state.patches.push(patch);
	},
	teardownApp: async () => {},
}));
vi.mock("./apps.server", () => ({
	appLocation: () => ({
		folder: "demo-1234abcd",
		appRoot: "/etc/nitrobase/apps/demo-1234abcd",
		appId: "app-1",
	}),
	deployedServices: () => ["db", "api", "worker"],
	getAppRow: async () => ({}),
	getAppServer: async () => ({}),
	listAppDomains: async () => [],
	resolveServerIps: async () => [],
}));

const { runMove } = await import("./move.server");

const ctx = {
	deploymentId: "dep-1",
	event: () => {},
	log: () => {},
	setCancelState: () => {},
	setRollback: async () => {},
	setWorkDir: async () => {},
	servicesStopped: async (services: string[]) => {
		state.stopped.push(...services);
	},
	servicesStarted: async (services: string[] | "all") => {
		state.started.push(...(services === "all" ? ["<all>"] : services));
	},
};

const move = () =>
	runMove(
		{
			actor: {} as never,
			app: {
				id: "app-1",
				name: "Demo",
				folder: "demo-1234abcd",
				status: state.status,
			} as never,
			source: { id: "src", name: "Source" } as never,
			target: { id: "dst", name: "Target", host: "10.0.0.2" } as never,
			destination: {} as never,
		},
		ctx as never,
	);

const starts = () =>
	state.commands.filter((command) => /docker compose .* start\b/.test(command));

beforeEach(() => {
	state.commands = [];
	state.patches = [];
	state.stopped = [];
	state.started = [];
});

describe("a failed move restarts what ran on the source", () => {
	it("starts exactly the services that were running", async () => {
		state.status = "running";
		state.running = ["db", "api"];
		const outcome = await move();
		expect(outcome.success).toBe(false);
		expect(starts()).toHaveLength(1);
		expect(starts()[0]).toMatch(/ start 'db' 'api'$/);
		// Recovery bookkeeping names only those too.
		expect(state.stopped).toEqual(["db", "api"]);
		expect(state.started).toEqual(["db", "api"]);
		expect(state.patches.at(-1)).toMatchObject({ status: "running" });
	});

	it("leaves an app that was stopped stopped, with its status", async () => {
		state.status = "stopped";
		state.running = [];
		await move();
		expect(starts()).toEqual([]);
		expect(state.started).toEqual([]);
		expect(state.patches.at(-1)).toMatchObject({ status: "stopped" });
	});
});
