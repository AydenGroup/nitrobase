import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	backupStopPhases,
	type TemplateBackup,
	TemplateBackupSchema,
} from "#/features/templates/schema.ts";

/**
 * Backup step order (OneDev #14, BUG-017): with `[backup] stop` and
 * `[backup.database]`, the writers stop BEFORE the dump (the database keeps
 * running for it), the database stops after it, then the volumes are
 * copied and the stopped services start again. Before the fix the dump ran
 * first, so writes acknowledged during the dump were in the volumes but not
 * in the dump. Stops go dependents first (`depends_on`); the restart starts
 * exactly what the backup stopped, dependencies first. `performAppBackup`
 * runs for real against a fake executor that records each step.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const state = vi.hoisted(() => ({
	services: [] as string[],
	backup: {} as unknown,
	status: "running",
	/** Services with a running container (default: all of `services`). */
	running: null as string[] | null,
	/** `depends_on` of the resolved compose model. */
	dependsOn: {} as Record<string, string[]>,
	/** Template has a dump strategy (`[backup.database]`). */
	strategy: true,
	/** Step whose command fails (`dump`, `stop:<service>`, `archive:<volume>`). */
	failAt: null as string | null,
	/** Recorded steps, in order. */
	steps: [] as string[],
	/** Job log events, in order. */
	events: [] as { code: string; params?: unknown }[],
	/** Services recorded as stopped and not started again. */
	recorded: new Set<string>(),
}));

vi.mock("#/db/index.ts", async () => {
	const { apps } = await import("#/db/schema/apps.ts");
	const app = () => ({
		id: "app-1",
		teamId: "team-1",
		serverId: "server-1",
		name: "Demo",
		templateId: "demo",
		folder: "demo",
		version: "1.0.0",
		commitSha: "abc",
		status: state.status,
		composeDeployed: "services: {}",
		customSpecEncrypted: null,
	});
	const row = { id: "backup-0123456789" };
	return {
		db: {
			select: () => ({
				from: (table: unknown) => ({
					where: () => ({
						limit: async () => (table === apps ? [app()] : []),
					}),
				}),
			}),
			insert: () => ({
				values: () => ({ returning: async () => [row] }),
			}),
			update: () => ({
				set: () => ({
					where: () =>
						Object.assign(Promise.resolve(), {
							returning: async () => [row],
						}),
				}),
			}),
		},
	};
});

vi.mock("#/config/server.ts", () => ({
	getConfig: () => ({
		BACKUP_JOB_TIMEOUT_MS: 60_000,
		BACKUP_TOOLS_IMAGE: "tools",
		BACKUP_TOOLS_BASE_IMAGE: "alpine",
		BACKUP_ZSTD_LEVEL: 3,
	}),
}));

vi.mock("#/features/apps/app-jobs.server.ts", () => ({
	run: async (
		executor: { exec: (command: string) => Promise<{ exitCode: number }> },
		_ctx: unknown,
		command: string,
		failure: string | ((detail: string) => Error),
	) => {
		const result = (await executor.exec(command)) as {
			exitCode: number;
			stdout: string;
		};
		if (result.exitCode !== 0) {
			throw typeof failure === "function"
				? failure("failed")
				: new Error(failure);
		}
		return result.stdout;
	},
}));

vi.mock("#/features/apps/apps.server.ts", () => ({
	appInputs: () => ({ publishedPorts: {} }),
	appOverrides: () => ({}),
	appLocation: (app: { folder: string }) => ({
		folder: app.folder,
		appRoot: `/apps/${app.folder}`,
	}),
	containerName: (folder: string, service: string) => `${folder}-${service}`,
	deployedServices: () => state.services,
	getAppManifest: async () => ({ backup: state.backup }),
	getAppServer: async () => ({ id: "server-1" }),
	listAppDomains: async () => [],
	readCustomSpec: () => null,
	readEnvValues: () => ({}),
	readServiceEnv: () => ({}),
}));

vi.mock("#/features/deployments/deployments.server.ts", () => ({
	redactingContext: (ctx: unknown) => ctx,
	registerJobRecovery: () => {},
}));

vi.mock("#/features/servers/servers.server.ts", () => ({
	getExecutor: async () => fakeExecutor,
}));
vi.mock("#/features/settings/instance-identity.server.ts", () => ({
	requireInstanceId: async () => "inst-1",
}));
vi.mock("#/server/services/server-setup.ts", () => ({
	assertServerOwned: async () => {},
}));
vi.mock("#/server/services/audit.ts", () => ({ audit: () => {} }));
vi.mock("#/server/services/events/bus.ts", () => ({ emitEvent: () => {} }));
vi.mock("#/utils/crypto.ts", () => ({ encrypt: (value: string) => value }));

vi.mock("#/plugins/server.ts", () => ({
	databaseStrategyFor: () =>
		state.strategy
			? {
					id: "postgres",
					file: "dump.sql",
					dumpCommand: (container: string) => `DUMP ${container}`,
				}
			: null,
}));

vi.mock("#/server/services/apps/commands.ts", async (importOriginal) => ({
	parseServiceStatus: (
		await importOriginal<typeof import("#/server/services/apps/commands.ts")>()
	).parseServiceStatus,
	appContainerCheckScript: () => "CHECK",
	bindSourcesCheckScript: () => "BINDCHECK",
	composeConfigCommand: () => "CONFIG",
	composeStatusCommand: () => "STATUS",
	composeServiceCommand: (
		_location: unknown,
		action: string,
		service?: string,
	) => `COMPOSE ${action}${service ? ` ${service}` : ""}`,
	composeStartServicesCommand: (_location: unknown, services: string[]) =>
		`COMPOSE start-services ${services.join(",")}`,
}));

vi.mock("#/server/services/backup/archive.ts", () => ({
	archiveSourceCommand: (_image: string, source: string) => `ARCHIVE ${source}`,
	buildManifest: () => ({}),
	COMPOSE_FILE: "compose.yml",
	checksumsCommand: () => "NOOP",
	ENV_FILE: "env.enc",
	ensureToolsImageCommand: () => "NOOP",
	fileDigestCommand: () => "NOOP",
	hookCommand: (container: string) => `HOOK ${container}`,
	MANIFEST_FILE: "manifest.json",
	packCommand: () => "NOOP",
	parseChecksums: () => new Map(),
	parseFileDigest: () => ({ size: 1, sha256: "f".repeat(64) }),
	parseSizes: () => new Map(),
	sizesCommand: () => "NOOP",
}));

vi.mock("./rclone.server", () => ({
	newWorkDir: () => "/work",
	openRclone: async () => ({
		workDir: "/work",
		redact: (value: string) => value,
		remotePath: (key: string) => key,
		run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		close: async () => {},
	}),
}));
vi.mock("./destinations.server", () => ({
	getDestinationRow: async () => ({}),
	pickServer: async () => ({}),
}));

/**
 * Records each step. `CONFIG` answers with every volume named and the
 * `depends_on` map form; `STATUS` with the running containers.
 */
const fakeExecutor = {
	kind: "ssh" as const,
	async exec(command: string) {
		const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
		let step: string | null = null;
		if (command === "CONFIG") {
			const volumes = (state.backup as TemplateBackup).volumes;
			return ok(
				JSON.stringify({
					services: Object.fromEntries(
						state.services.map((service) => [
							service,
							{
								depends_on: Object.fromEntries(
									(state.dependsOn[service] ?? []).map((target) => [
										target,
										{ condition: "service_healthy" },
									]),
								),
							},
						]),
					),
					volumes: Object.fromEntries(
						volumes.map((volume) => [volume, { name: volume }]),
					),
				}),
			);
		}
		if (command === "STATUS") {
			if (state.failAt === "status") {
				return { stdout: "", stderr: "boom", exitCode: 1 };
			}
			const running = state.running ?? state.services;
			return ok(
				state.services
					.map(
						(service) =>
							`${service}\t${running.includes(service) ? "running" : "exited"}\t0\t0\t`,
					)
					.join("\n"),
			);
		}
		if (command.startsWith("DUMP ")) step = "dump";
		else if (command.startsWith("COMPOSE stop ")) {
			step = `stop:${command.slice("COMPOSE stop ".length)}`;
		} else if (command.startsWith("COMPOSE start-services ")) {
			step = `start:${command.slice("COMPOSE start-services ".length)}`;
		} else if (command.startsWith("COMPOSE start")) step = "start-all";
		else if (command.startsWith("ARCHIVE ")) {
			step = `archive:${command.slice("ARCHIVE ".length)}`;
		} else if (command.startsWith("HOOK ")) step = "pre_hook";
		if (!step) return ok();
		state.steps.push(step);
		return state.failAt === step
			? { stdout: "", stderr: "boom", exitCode: 1 }
			: ok();
	},
	async upload() {},
	close() {},
};

const ctx = {
	deploymentId: "dep-1",
	event: (code: string, params?: unknown) => {
		state.events.push({ code, params });
	},
	log: () => {},
	servicesStopped: async (services: string[]) => {
		for (const service of services) state.recorded.add(service);
	},
	servicesStarted: async (services: string[] | "all") => {
		if (services === "all") state.recorded.clear();
		else for (const service of services) state.recorded.delete(service);
	},
	setWorkDir: async () => {},
	setCancelState: () => {},
};

const { performAppBackup } = await import("./backups.server");

function backup(input: {
	services: string[];
	plan: Record<string, unknown>;
	dependsOn?: Record<string, string[]>;
	strategy?: boolean;
}) {
	state.services = input.services;
	state.backup = TemplateBackupSchema.parse(input.plan);
	state.dependsOn = input.dependsOn ?? {};
	state.strategy = input.strategy ?? true;
	return performAppBackup(
		{
			appId: "app-1",
			actor: { userId: "user-1", teamId: "team-1" } as never,
			destination: { id: "dest-1", name: "Local" } as never,
			trigger: "manual",
			deploymentId: "dep-1",
		},
		ctx as never,
	);
}

/** Appwrite-like: the API and a worker need MongoDB and PostgreSQL. */
const appwrite = {
	services: ["mongodb", "postgresql", "appwrite", "appwrite-worker-builds"],
	dependsOn: {
		appwrite: ["mongodb", "postgresql"],
		"appwrite-worker-builds": ["appwrite", "postgresql"],
	},
	plan: {
		volumes: ["appwrite-uploads"],
		stop: true,
		hooks: [{ when: "pre", service: "appwrite", command: ["sync"] }],
		database: {
			type: "postgres",
			service: "postgresql",
			mode: "cluster",
			user: "appwrite",
			database: "appwrite",
		},
	},
};
const APPWRITE_WRITERS = ["appwrite-worker-builds", "appwrite", "mongodb"];

/** Plausible: compose order puts ClickHouse before the app using it. */
const plausible = {
	services: ["plausible_db", "plausible_events_db", "plausible"],
	dependsOn: { plausible: ["plausible_db", "plausible_events_db"] },
	plan: {
		volumes: ["event-data", "plausible-data"],
		stop: ["plausible", "plausible_events_db"],
		database: {
			type: "postgres",
			mode: "database",
			user: "postgres",
			database: "plausible_db",
			service: "plausible_db",
		},
	},
};

const database = {
	type: "postgres",
	mode: "database",
	user: "postgres",
	database: "app",
};

beforeEach(() => {
	state.status = "running";
	state.running = null;
	state.failAt = null;
	state.steps = [];
	state.events = [];
	state.recorded = new Set();
});

describe("backupStopPhases", () => {
	const plan = (stop: TemplateBackup["stop"]) => ({ stop });

	it("keeps the dumped service running until after the dump", () => {
		expect(backupStopPhases(plan(true), ["app", "worker", "db"], "db")).toEqual(
			{ beforeDump: ["app", "worker"], afterDump: ["db"] },
		);
	});

	it("keeps the template's list order, not the compose order", () => {
		expect(
			backupStopPhases(
				plan(["plausible", "plausible_events_db", "gone"]),
				["plausible_db", "plausible_events_db", "plausible"],
				"plausible_db",
			),
		).toEqual({
			beforeDump: ["plausible", "plausible_events_db"],
			afterDump: [],
		});
	});

	it("stops dependents before what they depend on, list order as tiebreak", () => {
		expect(
			backupStopPhases(
				plan(["cache", "events", "web", "worker"]),
				["cache", "events", "web", "worker", "db"],
				"db",
				{
					web: ["events", "cache", "db"],
					worker: ["web"],
				},
			),
		).toEqual({
			beforeDump: ["worker", "web", "cache", "events"],
			afterDump: [],
		});
	});

	it("follows depends_on through services outside the stop set", () => {
		expect(
			backupStopPhases(plan(["store", "web"]), ["store", "api", "web"], null, {
				web: ["api"],
				api: ["store"],
			}),
		).toEqual({ beforeDump: ["web", "store"], afterDump: [] });
	});

	it("survives a depends_on cycle (list order)", () => {
		expect(
			backupStopPhases(plan(true), ["a", "b"], null, { a: ["b"], b: ["a"] }),
		).toEqual({ beforeDump: ["a", "b"], afterDump: [] });
	});

	it("stops only running services", () => {
		expect(backupStopPhases(plan(true), ["app"], "db")).toEqual({
			beforeDump: ["app"],
			afterDump: [],
		});
	});

	it("stops nothing for an online backup", () => {
		expect(backupStopPhases(plan(false), ["app", "db"], "db")).toEqual({
			beforeDump: [],
			afterDump: [],
		});
	});

	it("stops everything first without a dump", () => {
		expect(backupStopPhases(plan(true), ["app", "db"], null)).toEqual({
			beforeDump: ["app", "db"],
			afterDump: [],
		});
	});
});

describe("performAppBackup step order", () => {
	it("appwrite-like (stop = true): writers, dump, database, copy, start", async () => {
		await backup(appwrite);
		expect(state.steps).toEqual([
			"pre_hook",
			...APPWRITE_WRITERS.map((service) => `stop:${service}`),
			"dump",
			"stop:postgresql",
			"archive:appwrite-uploads",
			"start:postgresql,mongodb,appwrite,appwrite-worker-builds",
		]);
		const before = state.events.find(
			(event) => event.code === "backup.stopping_before_dump",
		);
		expect(before?.params).toEqual({
			services: { $list: APPWRITE_WRITERS },
			database: "postgresql",
		});
		expect(
			state.events.find((event) => event.code === "backup.stopping")?.params,
		).toEqual({ services: { $list: ["postgresql"] } });
		expect(state.recorded.size).toBe(0);
	});

	it('n8n-like (stop = ["n8n"]): n8n stops before the dump, Postgres keeps running', async () => {
		await backup({
			services: ["postgres", "n8n"],
			dependsOn: { n8n: ["postgres"] },
			plan: {
				volumes: ["n8n-data"],
				stop: ["n8n"],
				database: { ...database, service: "postgres" },
			},
		});
		expect(state.steps).toEqual([
			"stop:n8n",
			"dump",
			"archive:n8n-data",
			"start:n8n",
		]);
		expect(state.events.some((event) => event.code === "backup.stopping")).toBe(
			false,
		);
	});

	it("plausible-like (two-item list): Plausible stops before ClickHouse, both before the dump", async () => {
		await backup(plausible);
		expect(state.steps).toEqual([
			"stop:plausible",
			"stop:plausible_events_db",
			"dump",
			"archive:event-data",
			"archive:plausible-data",
			"start:plausible_events_db,plausible",
		]);
	});

	it("stop = false: online dump, nothing stopped or started", async () => {
		await backup({
			services: ["db", "app"],
			plan: {
				volumes: ["db-config"],
				stop: false,
				database: { ...database, service: "db" },
			},
		});
		expect(state.steps).toEqual(["dump", "archive:db-config"]);
	});

	it("without a dump strategy (database in the app): stops first, as before", async () => {
		await backup({
			services: ["app"],
			plan: { volumes: ["data"], stop: true, database: "app" },
			strategy: false,
		});
		expect(state.steps).toEqual(["stop:app", "archive:data", "start:app"]);
		expect(
			state.events.some(
				(event) => event.code === "backup.stopping_before_dump",
			),
		).toBe(false);
	});

	it("the dumped service is the app itself: dumped running, then stopped", async () => {
		await backup({
			services: ["app"],
			plan: { volumes: ["data"], stop: true, database: "app" },
		});
		expect(state.steps).toEqual([
			"dump",
			"stop:app",
			"archive:data",
			"start:app",
		]);
	});

	it("an app that isn't running is not stopped or started", async () => {
		state.status = "stopped";
		state.running = [];
		await backup(appwrite);
		expect(state.steps).toEqual([
			"pre_hook",
			"dump",
			"archive:appwrite-uploads",
		]);
	});

	it("never runs a bare compose start", async () => {
		state.failAt = "dump";
		await expect(backup(appwrite)).rejects.toThrow();
		state.failAt = null;
		await backup(plausible);
		expect(state.steps).not.toContain("start-all");
	});
});

describe("services that weren't running stay stopped", () => {
	// The owner stopped the worker; `migrate` is a finished one-shot.
	const withStopped = {
		...appwrite,
		services: [...appwrite.services, "migrate"],
	};
	const running = appwrite.services.filter(
		(service) => service !== "appwrite-worker-builds",
	);

	it("after a successful backup", async () => {
		state.running = running;
		await backup(withStopped);
		expect(state.steps).toEqual([
			"pre_hook",
			"stop:appwrite",
			"stop:mongodb",
			"dump",
			"stop:postgresql",
			"archive:appwrite-uploads",
			"start:postgresql,mongodb,appwrite",
		]);
	});

	it("after a failed backup", async () => {
		state.running = running;
		state.failAt = "archive:appwrite-uploads";
		await expect(backup(withStopped)).rejects.toThrow();
		expect(state.steps.at(-1)).toBe("start:postgresql,mongodb,appwrite");
		expect(state.recorded.size).toBe(0);
	});
});

describe("performAppBackup failure restarts what it stopped", () => {
	const stops = (services: string[]) =>
		services.map((service) => `stop:${service}`);
	it.each([
		[
			"dump",
			[...stops(APPWRITE_WRITERS)],
			"mongodb,appwrite,appwrite-worker-builds",
		],
		[
			// A failed stop may be half done: started again too.
			"stop:postgresql",
			[...stops(APPWRITE_WRITERS), "dump"],
			"postgresql,mongodb,appwrite,appwrite-worker-builds",
		],
		[
			"archive:appwrite-uploads",
			[...stops(APPWRITE_WRITERS), "dump", "stop:postgresql"],
			"postgresql,mongodb,appwrite,appwrite-worker-builds",
		],
		[
			"stop:appwrite",
			["stop:appwrite-worker-builds"],
			"appwrite,appwrite-worker-builds",
		],
	])("fails at %s: starts exactly the stopped services again", async (failAt, before, restarted) => {
		state.failAt = failAt;
		await expect(backup(appwrite)).rejects.toThrow();
		expect(state.steps).toEqual([
			"pre_hook",
			...before,
			failAt,
			`start:${restarted}`,
		]);
		// Started: nothing is left for the job recovery.
		expect(state.recorded.size).toBe(0);
	});

	it("a failed restart is left to the job recovery", async () => {
		state.failAt = "dump";
		const restart = "start:mongodb,appwrite,appwrite-worker-builds";
		const original = fakeExecutor.exec;
		fakeExecutor.exec = async (command: string) => {
			const result = await original(command);
			return state.steps.at(-1) === restart &&
				command.includes("start-services")
				? { stdout: "", stderr: "boom", exitCode: 1 }
				: result;
		};
		try {
			await expect(backup(appwrite)).rejects.toThrow();
		} finally {
			fakeExecutor.exec = original;
		}
		expect([...state.recorded]).toEqual(APPWRITE_WRITERS);
	});

	it("a failed pre hook stops nothing", async () => {
		state.failAt = "pre_hook";
		await expect(backup(appwrite)).rejects.toThrow();
		expect(state.steps).toEqual(["pre_hook"]);
	});
});

describe("what runs comes from the server, not apps.status (BUG-020)", () => {
	it("stops the running containers of an app left in error", async () => {
		// A failed update set `error`; every container still runs.
		state.status = "error";
		await backup(appwrite);
		expect(state.steps).toEqual([
			"pre_hook",
			"stop:appwrite-worker-builds",
			"stop:appwrite",
			"stop:mongodb",
			"dump",
			"stop:postgresql",
			"archive:appwrite-uploads",
			"start:postgresql,mongodb,appwrite,appwrite-worker-builds",
		]);
		expect(state.events.map((event) => event.code)).toContain(
			"backup.stopping",
		);
	});

	it("stops what runs even when the row says stopped", async () => {
		state.status = "stopped";
		state.running = ["mongodb"];
		await backup(appwrite);
		expect(state.steps).toContain("stop:mongodb");
		expect(state.steps.at(-1)).toBe("start:mongodb");
	});

	it("refuses to copy volumes when the container state is unknown", async () => {
		state.status = "error";
		state.failAt = "status";
		await expect(backup(appwrite)).rejects.toThrow("COMPOSE_PS_FAILED");
		expect(state.steps).not.toContain("archive:appwrite-uploads");
	});
});
