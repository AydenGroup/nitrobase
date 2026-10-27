import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Generated secrets survive a failed first deploy (bug: a retried first
 * deploy regenerated every secret and broke data initialised with the
 * first ones). `runDeploy` runs for real against an in-memory app row and
 * a fake executor; the template engine is reduced to "keep carried-over
 * generated values, generate the rest".
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const state = vi.hoisted(() => ({
	row: {} as Record<string, unknown>,
	files: new Map<string, string>(),
	volumes: 0,
	failPull: false,
	ps: "db\trunning\t0\t0\thealthy\n",
	/** Successive `ps` outputs (the last one repeats); empty: `ps`. */
	psSeq: [] as string[],
	stableSamples: 1,
	unhealthyGraceMs: 60_000,
	logs: "",
	timeoutMs: 60_000,
	heartbeatMs: 60_000,
	pullDelayMs: 0,
	/** The bind check finds no regular file at a file bind. */
	fileMissing: false,
	/** An empty folder sits where a rendered file goes. */
	emptyDir: false,
	/** The compose mounts ./config.json, which nothing writes. */
	namedConfig: false,
	/** ./config.json is on the server (before up) / a file after up. */
	configPresent: false,
	/** `docker compose up` fails (a dependency is unhealthy). */
	failUp: false,
	/** What the OOM inspect prints: `service<TAB>OOMKilled<TAB>memory bytes` rows. */
	oomRows: "",
	commands: [] as string[],
	/** stdin of each command (SQL of psql runs). */
	inputs: [] as (string | undefined)[],
	/** psql exits non-zero. */
	psqlFails: false,
	audits: [] as { action: string; meta?: unknown }[],
	/** Warnings counted through `ctx.addWarnings` (job summary). */
	warnings: 0,
	events: [] as { code: string; params: unknown }[],
	/** What `getTemplateManifest` returns (version source, rollback mode). */
	templateManifest: {
		source: { versions: "releases" },
		updates: { rollback: "redeploy" },
	} as Record<string, unknown>,
}));

vi.mock("#/server/services/audit.ts", () => ({
	audit: (event: { action: string; meta?: unknown }) => {
		state.audits.push({ action: event.action, meta: event.meta });
	},
}));

const APP_ROOT = "/etc/nitrobase/apps/demo-1234abcd";
const INSTANCE = "inst-1";
const VARIABLES = {
	// Read by Postgres only when it initialises its data directory.
	POSTGRES_PASSWORD: { value: "${password:40}", initial_only: true },
	JWT_SECRET: { value: "${password:48}" },
	SITE_URL: { value: "${url}" },
};

vi.mock("#/db/index.ts", async () => {
	const { apps } = await import("#/db/schema/apps.ts");
	return {
		db: {
			select: () => ({
				from: () => ({
					where: () => ({ limit: async () => [{ ...state.row }] }),
				}),
			}),
			update: (table: unknown) => ({
				set: (patch: Record<string, unknown>) => ({
					where: async () => {
						if (table === apps) Object.assign(state.row, patch);
					},
				}),
			}),
		},
	};
});

vi.mock("#/config/server.ts", () => ({
	getConfig: () => ({
		APP_BUILD_RETRIES: 0,
		APP_PULL_HEARTBEAT_MS: state.heartbeatMs,
		APP_HEALTH_TIMEOUT_MS: state.timeoutMs,
		APP_HEALTH_INTERVAL_MS: 1,
		APP_READY_STABLE_MS: 0,
		APP_READY_STABLE_SAMPLES: state.stableSamples,
		APP_UNHEALTHY_GRACE_MS: state.unhealthyGraceMs,
		APP_UNHEALTHY_SAMPLES: 3,
		APP_DEPLOY_RESTART_LIMIT: 3,
		APP_HEALTH_PROBE_TIMEOUT_MS: 1000,
		APP_HINT_LOG_LINES: 80,
		APP_HINT_MAX_READS: 5,
		NITROBASE_NETWORK: "nitrobase",
		APP_ROTATE_HOOK_TIMEOUT_MS: 60_000,
		APP_ROTATE_HOOK_SLACK_MS: 30_000,
	}),
}));

vi.mock("#/features/settings/instance-identity.server.ts", () => ({
	requireInstanceId: async () => INSTANCE,
}));

vi.mock("#/server/services/server-setup.ts", () => ({
	assertServerOwned: async () => {},
}));

/** Answers the deploy's commands from the in-memory server folder. */
const fakeExecutor = {
	kind: "ssh" as const,
	async exec(command: string, options?: { input?: string }) {
		state.commands.push(command);
		state.inputs.push(options?.input);
		const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
		if (command.includes("exec psql") && state.psqlFails) {
			return {
				stdout: "",
				stderr: 'ERROR:  permission denied for table "sessions"',
				exitCode: 1,
			};
		}
		if (command.includes('echo "owner=')) {
			const owner = state.files.get(`${APP_ROOT}/.nitrobase-instance`);
			const env = state.files.get(`${APP_ROOT}/.env`);
			const ours = owner?.trim() === INSTANCE;
			return ok(
				[
					`owner=${owner?.trim() ?? "-"}`,
					`env=${ours && env !== undefined ? Buffer.from(env).toString("base64") : "-"}`,
					`volumes=${state.volumes}`,
				].join("\n"),
			);
		}
		if (command.includes("config --format json")) {
			return ok(
				JSON.stringify({
					services: {
						db: {
							volumes: [
								{ type: "bind", source: `${APP_ROOT}/volumes/db/data` },
								{ type: "bind", source: `${APP_ROOT}/volumes/db/init.sql` },
								...(state.namedConfig
									? [{ type: "bind", source: `${APP_ROOT}/config.json` }]
									: []),
							],
						},
					},
				}),
			);
		}
		if (command.includes("rmdir --")) {
			return ok(
				state.emptyDir ? `replaced=${APP_ROOT}/volumes/db/init.sql\n` : "",
			);
		}
		if (command.includes(`${APP_ROOT}/config.json`)) {
			// Before up: warns while absent; after up: Docker's empty folder.
			if (command.includes("bind-file-warning=")) {
				return ok(
					state.configPresent
						? ""
						: `bind-file-warning=${APP_ROOT}/config.json\n`,
				);
			}
			if (!state.configPresent) {
				return {
					stdout: "",
					stderr: `bind-file-missing=${APP_ROOT}/config.json\n`,
					exitCode: 97,
				};
			}
			return ok();
		}
		if (command.includes("bind-file-missing=") && state.fileMissing) {
			return {
				stdout: "",
				stderr: `bind-file-missing=${APP_ROOT}/volumes/db/init.sql\n`,
				exitCode: 97,
			};
		}
		if (command.includes(" pull") && state.failPull) {
			return { stdout: "", stderr: "pull failed", exitCode: 1 };
		}
		if (command.includes(" pull") && state.pullDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, state.pullDelayMs));
		}
		// The status sample also runs `docker inspect`: match the OOM format.
		if (command.includes("OOMKilled")) return ok(state.oomRows);
		if (command.includes(" up -d") && state.failUp) {
			return {
				stdout: "",
				stderr: "dependency failed to start: container demo-kong is unhealthy",
				exitCode: 1,
			};
		}
		if (command.includes(" ps ")) {
			return ok(
				state.psSeq.length > 1
					? state.psSeq.shift()
					: (state.psSeq[0] ?? state.ps),
			);
		}
		if (command.includes(" logs ")) return ok(state.logs);
		return ok();
	},
	async upload(content: string | Buffer, remotePath: string) {
		state.files.set(remotePath, content.toString());
	},
	async readFile(remotePath: string) {
		return state.files.get(remotePath) ?? "";
	},
	async shell() {
		throw new Error("unused");
	},
	close() {},
};

vi.mock("#/features/servers/servers.server.ts", () => ({
	getExecutor: async () => fakeExecutor,
}));

vi.mock("./apps.server", async (importOriginal) => {
	const original = await importOriginal<typeof import("./apps.server")>();
	return {
		...original,
		getAppServer: async () => ({
			id: "srv",
			requireLimits: false,
			defaultMemoryMb: null,
			tunnelOnly: false,
			tunnelEnabled: false,
		}),
		listAppDomains: async () => [],
		// Access checks are not under test here.
		getAppRow: async () => ({ ...state.row }),
		getAppManifest: async () => ({
			variables: VARIABLES,
			failure_hints: { jsr_unreachable: { variable: "FUNCTIONS_JSR_MIRROR" } },
		}),
		appLocation: () => ({
			folder: "demo-1234abcd",
			appRoot: APP_ROOT,
			appId: "app-1",
		}),
		appTraefikPath: () => "/etc/nitrobase/traefik/dynamic/app-demo.yml",
		readServiceEnv: () => ({}),
	};
});

// No encryption key in tests: the plain text stands in for the cipher.
vi.mock("#/utils/crypto.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/utils/crypto.ts")>()),
	encrypt: (text: string) => text,
	decrypt: (text: string) => text,
}));

vi.mock("./sources.server", () => ({
	isVersionedSource: () => true,
	sourceKindOf: () => "template",
	sourceDriver: async () => ({ renderInput: async () => null }),
}));

vi.mock("#/features/databases/links.server.ts", () => ({
	appLinkRender: async () => ({ linkNetworks: [], linkEnv: {}, networks: [] }),
	ensureLinkNetworks: async () => {},
	pruneLinkNetworks: async () => {},
}));

vi.mock("#/server/services/templates/compose-policy.ts", () => ({
	assertSafeCompose: () => {},
	LINK_NETWORK_NAME_PREFIX: "nitrobase-link-",
}));

vi.mock("#/features/templates/templates.server.ts", async () => {
	const { isGeneratedExpression } = await import(
		"#/server/services/apps/env-state.ts"
	);
	return {
		getTemplateManifest: async () => state.templateManifest,
		isSecretFile: () => false,
		serviceEnvFile: (service: string) => `service-env/${service}.env`,
		renderTemplate: (input: {
			existing?: Record<string, string>;
			domain: string;
			version?: string;
		}) => {
			const definitions: Record<string, string> = Object.fromEntries(
				Object.entries(VARIABLES).map(([name, v]) => [name, v.value]),
			);
			// v2 introduces a generated variable.
			if (input.version === "v2") definitions.NEW_KEY = "${hex:8}";
			const values = Object.fromEntries(
				Object.entries(definitions).map(([name, expression]) => [
					name,
					isGeneratedExpression(expression)
						? (input.existing?.[name] ??
							// Quotes and `$` exercise the .env round-trip.
							`p'$${randomBytes(12).toString("base64")}"`)
						: `https://${input.domain}`,
				]),
			);
			return {
				version: input.version ?? "v1",
				commitSha: "a".repeat(40),
				compose: "services: {}\n",
				values,
				files: [{ path: "volumes/db/init.sql", content: Buffer.from("") }],
				warnings: [],
				composeModel: {
					services: {
						db: {
							volumes: [
								`${APP_ROOT}/volumes/db/data:/var/lib/postgresql/data`,
								`${APP_ROOT}/volumes/db/init.sql:/docker-entrypoint-initdb.d/init.sql`,
							],
						},
					},
				},
				containerNames: { db: "demo-db" },
				services: ["db"],
				routes: [],
				definitions,
				policy: {},
				linkNetworks: [],
				fileBinds: {
					required: [{ service: "db", path: "volumes/db/init.sql" }],
					named: state.namedConfig
						? [{ service: "db", path: "config.json" }]
						: [],
				},
			};
		},
	};
});

const { runDeploy, deployThenRotateHook, rerunRotateHook, runRotateHook } =
	await import("./app-jobs.server");
const { deployedEnvValues } = await import("./apps.server");

function ctx() {
	return {
		deploymentId: "dep",
		event: (code: string, params?: unknown) => {
			state.events.push({ code, params });
		},
		log: () => {},
		addWarnings: async (count: number) => {
			state.warnings += count;
		},
	} as never;
}

const codes = () => state.events.map((event) => event.code);
const storedEnv = () =>
	JSON.parse(String(state.row.envEncrypted)) as Record<string, string>;
const serverEnv = async () => {
	const { parseRenderedEnvFile } = await import(
		"#/server/services/templates/variables.ts"
	);
	return parseRenderedEnvFile(state.files.get(`${APP_ROOT}/.env`) ?? "");
};

beforeEach(() => {
	state.row = {
		id: "app-1",
		name: "Demo",
		folder: "demo-1234abcd",
		templateId: "demo",
		serverId: "srv",
		status: "deploying",
		version: "v1",
		commitSha: null,
		envEncrypted: null,
		envPendingAt: null,
		envDeployedEncrypted: null,
		serviceEnvEncrypted: null,
		customSpecEncrypted: null,
		composeDeployed: null,
		inputs: { overrides: {} },
	};
	state.files.clear();
	state.volumes = 0;
	state.failPull = false;
	state.ps = "db\trunning\t0\t0\thealthy\n";
	state.psSeq = [];
	state.stableSamples = 1;
	state.unhealthyGraceMs = 60_000;
	state.logs = "";
	state.timeoutMs = 60_000;
	state.heartbeatMs = 60_000;
	state.pullDelayMs = 0;
	state.fileMissing = false;
	state.emptyDir = false;
	state.namedConfig = false;
	state.configPresent = false;
	state.failUp = false;
	state.oomRows = "";
	state.commands = [];
	state.inputs = [];
	state.psqlFails = false;
	state.audits = [];
	state.warnings = 0;
	state.events = [];
	state.templateManifest = {
		source: { versions: "releases" },
		updates: { rollback: "redeploy" },
	};
});

describe("JWT secret rotation signs users out (BUG-010)", () => {
	const hook = {
		label: "Sign out all users",
		default: true,
		service: "db",
		user: "supabase_admin",
		database: "postgres",
		sql: "delete from auth.refresh_tokens; delete from auth.sessions;",
	};
	const deployed = "services:\n  db:\n    image: postgres\n";

	it("runs the step after a successful deploy only", async () => {
		const ran: string[] = [];
		const steps = (success: boolean) => ({
			deploy: async () => {
				ran.push("deploy");
				return { success };
			},
			hook: async () => {
				ran.push("hook");
			},
		});
		expect(
			await deployThenRotateHook(ctx(), "JWT_SECRET", true, steps(true)),
		).toEqual({ success: true });
		expect(ran).toEqual(["deploy", "hook"]);

		ran.length = 0;
		expect(
			await deployThenRotateHook(ctx(), "JWT_SECRET", true, steps(false)),
		).toEqual({ success: false });
		expect(ran).toEqual(["deploy"]);
		expect(codes()).not.toContain("app.rotate_hook_skipped");
	});

	it("skips the step when the owner unticked it", async () => {
		const ran: string[] = [];
		await deployThenRotateHook(ctx(), "JWT_SECRET", false, {
			deploy: async () => ({ success: true }),
			hook: async () => {
				ran.push("hook");
			},
		});
		expect(ran).toEqual([]);
		expect(state.events).toContainEqual({
			code: "app.rotate_hook_skipped",
			params: { name: "JWT_SECRET" },
		});
	});

	it("deletes sessions and refresh tokens as the template's role in its service", async () => {
		state.row.composeDeployed = deployed;
		const ok = await runRotateHook(
			{} as never,
			"app-1",
			"JWT_SECRET",
			hook,
			ctx(),
		);
		expect(ok).toBe(true);
		const index = state.commands.findIndex((c) => c.includes("exec psql"));
		expect(state.commands[index]).toContain("'demo-1234abcd-db'");
		expect(state.commands[index]).toContain("'supabase_admin' 'postgres'");
		// SQL on stdin, never on the command line.
		expect(state.commands[index]).not.toContain("auth.sessions");
		expect(state.inputs[index]).toBe(hook.sql);
		expect(codes()).toContain("app.rotate_hook_done");
		expect(state.audits).toContainEqual({
			action: "app.variable.rotate_hook",
			meta: { name: "JWT_SECRET", service: "db", ok: true, rerun: false },
		});
		expect(state.warnings).toBe(0);
	});

	it("remembers a failed step for the overview and forgets it once it succeeds", async () => {
		state.row.composeDeployed = deployed;
		// The stored overrides are kept as they are (never decrypted here).
		state.row.inputs = { overridesEncrypted: "sealed" };
		state.psqlFails = true;
		await runRotateHook({} as never, "app-1", "JWT_SECRET", hook, ctx());
		// Counted in the job's summary (success with warnings).
		expect(state.warnings).toBe(1);
		expect(state.row.inputs).toEqual({
			overridesEncrypted: "sealed",
			rotateHookFailed: ["JWT_SECRET"],
		});

		state.psqlFails = false;
		expect(
			await runRotateHook({} as never, "app-1", "JWT_SECRET", hook, ctx(), {
				rerun: true,
			}),
		).toBe(true);
		expect(state.row.inputs).toEqual({ overridesEncrypted: "sealed" });
		expect(JSON.stringify(state.row.inputs)).not.toContain("rotateHookFailed");
		expect(state.audits.at(-1)).toEqual({
			action: "app.variable.rotate_hook",
			meta: { name: "JWT_SECRET", service: "db", ok: true, rerun: true },
		});
	});

	it("refuses to run a step again that has not failed", async () => {
		state.row.inputs = { overrides: {} };
		await expect(
			rerunRotateHook({} as never, "app-1", "JWT_SECRET"),
		).rejects.toMatchObject({ code: "APP_ROTATE_HOOK_NOT_PENDING" });
		// Not declared by the template (no on_rotate), even if flagged.
		state.row.inputs = { overrides: {}, rotateHookFailed: ["JWT_SECRET"] };
		await expect(
			rerunRotateHook({} as never, "app-1", "JWT_SECRET"),
		).rejects.toMatchObject({ code: "APP_ROTATE_HOOK_NOT_PENDING" });
	});

	it("turns a failed step into a coded warning (the rotation stands)", async () => {
		state.row.composeDeployed = deployed;
		state.psqlFails = true;
		const ok = await runRotateHook(
			{} as never,
			"app-1",
			"JWT_SECRET",
			hook,
			ctx(),
		);
		expect(ok).toBe(false);
		expect(state.events).toContainEqual({
			code: "job.warning",
			params: {
				warning: {
					$error: expect.objectContaining({
						code: "APP_ROTATE_HOOK_FAILED",
						params: expect.objectContaining({
							name: "JWT_SECRET",
							service: "db",
						}),
					}),
				},
			},
		});
		expect(state.audits).toContainEqual({
			action: "app.variable.rotate_hook",
			meta: { name: "JWT_SECRET", service: "db", ok: false, rerun: false },
		});
	});

	it("warns instead of running when the service is not deployed", async () => {
		state.row.composeDeployed = "services:\n  web:\n    image: nginx\n";
		const ok = await runRotateHook(
			{} as never,
			"app-1",
			"JWT_SECRET",
			hook,
			ctx(),
		);
		expect(ok).toBe(false);
		expect(state.commands.some((c) => c.includes("exec psql"))).toBe(false);
		expect(JSON.stringify(state.events)).toContain(
			"APP_ROTATE_HOOK_SERVICE_MISSING",
		);
	});
});

describe("readiness hints from known failure signatures", () => {
	it("names the template's workaround when a service cannot reach JSR", async () => {
		state.ps = "db\trunning\t0\t0\thealthy\nfunctions\trestarting\t0\t0\t\n";
		state.logs =
			"secret=abc\nError: JSR package manifest for '@panva/jose' failed to load. 403 Forbidden\n";
		state.timeoutMs = 20;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(false);
		const hint = {
			$error: {
				code: "SERVICE_JSR_UNREACHABLE_MIRROR",
				params: {
					service: "functions",
					package: "@panva/jose",
					variable: "FUNCTIONS_JSR_MIRROR",
				},
				text: null,
			},
		};
		expect(state.events).toContainEqual({
			code: "deploy.failure_hint",
			params: { hint },
		});
		// One hint per service, however long the wait.
		expect(codes().filter((c) => c === "deploy.failure_hint")).toHaveLength(1);
		// The app's error carries it.
		expect(state.row.lastErrorCode).toBe("APP_NOT_READY_HINT");
		expect(state.row.lastErrorParams).toMatchObject({ hint });
		// Logs never reach the job log.
		expect(JSON.stringify(state.events)).not.toContain("secret=abc");
	});

	it("keeps the plain timeout without a known signature", async () => {
		state.ps = "functions\trestarting\t0\t0\t\n";
		state.logs = "something else\n";
		state.timeoutMs = 20;
		await runDeploy("app-1", "deploy", undefined, ctx());
		expect(state.row.lastErrorCode).toBe("APP_READY_TIMEOUT");
		const reads = state.commands.filter((c) => c.includes(" logs "));
		expect(reads.length).toBeLessThanOrEqual(5);
	});
});

describe("out-of-memory hints", () => {
	const MIB = 1024 * 1024;
	const oomHint = (service: string, limitMb: number) => ({
		$error: {
			code: "SERVICE_OOM_KILLED",
			params: { service, limitMb },
			text: null,
		},
	});

	it("names the container killed for memory when compose up fails", async () => {
		state.failUp = true;
		state.oomRows = `db\tfalse\t0\nkong\ttrue\t${64 * MIB}\n`;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(false);
		expect(state.events).toContainEqual({
			code: "deploy.failure_hint",
			params: { hint: oomHint("kong", 64) },
		});
		// The failure itself is still the compose error.
		expect(state.row.lastErrorCode).toBe("COMPOSE_UP_FAILED");
	});

	it("adds no hint when nothing was killed for memory", async () => {
		state.failUp = true;
		state.oomRows = `db\tfalse\t0\nkong\tfalse\t${64 * MIB}\n`;
		await runDeploy("app-1", "deploy", undefined, ctx());
		expect(codes()).not.toContain("deploy.failure_hint");
		expect(state.row.lastErrorCode).toBe("COMPOSE_UP_FAILED");
	});

	it("names the killed service while waiting for a crash-looping one", async () => {
		state.ps = "db\trunning\t0\t0\thealthy\nkong\trestarting\t0\t0\t\n";
		state.oomRows = `kong\ttrue\t${64 * MIB}\n`;
		state.timeoutMs = 20;
		await runDeploy("app-1", "deploy", undefined, ctx());
		expect(state.events).toContainEqual({
			code: "deploy.failure_hint",
			params: { hint: oomHint("kong", 64) },
		});
		// One hint per service, however long the wait.
		expect(codes().filter((c) => c === "deploy.failure_hint")).toHaveLength(1);
		expect(state.row.lastErrorCode).toBe("APP_NOT_READY_HINT");
	});

	it("names the crash-looping service even when every sample catches it running", async () => {
		const line = (restarts: number) =>
			`db\trunning\t0\t0\thealthy\nkong\trunning\t0\t${restarts}\t\n`;
		state.stableSamples = 3;
		state.psSeq = [line(0), line(1), line(2), line(3)];
		state.oomRows = `kong\ttrue\t${64 * MIB}\n`;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(false);
		expect(state.events).toContainEqual({
			code: "deploy.failure_hint",
			params: { hint: oomHint("kong", 64) },
		});
		expect(state.row.lastErrorCode).toBe("APP_NOT_READY_HINT");
	});

	it("ignores a kill from before this deploy (OOMKilled stays set)", async () => {
		state.failUp = true;
		const now = Math.floor(Date.now() / 1000);
		state.oomRows = `now\t${now}\nkong\ttrue\t${64 * MIB}\t2020-01-01T00:00:00.123456789Z\n`;
		await runDeploy("app-1", "deploy", undefined, ctx());
		expect(codes()).not.toContain("deploy.failure_hint");
		expect(state.row.lastErrorCode).toBe("COMPOSE_UP_FAILED");
	});

	it("keeps a kill from during this deploy, dated on the host's clock", async () => {
		state.failUp = true;
		// The host's clock runs an hour ahead: only the duration counts.
		const hostNow = Math.floor(Date.now() / 1000) + 3600;
		const finished = new Date(hostNow * 1000).toISOString();
		state.oomRows = `now\t${hostNow}\nkong\ttrue\t${64 * MIB}\t${finished}\n`;
		await runDeploy("app-1", "deploy", undefined, ctx());
		expect(state.events).toContainEqual({
			code: "deploy.failure_hint",
			params: { hint: oomHint("kong", 64) },
		});
	});

	it("never reads OOM state for a one-shot service that exited 0", async () => {
		state.ps = "db\trunning\t0\t0\thealthy\nmigrate\texited\t0\t0\t\n";
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(true);
		expect(state.commands.some((c) => c.includes("OOMKilled"))).toBe(false);
	});
});

describe("readiness over time (BUG-004)", () => {
	const line = (service: string, status: string, restarts: number) =>
		`${service}\t${status}\t0\t${restarts}\t\n`;

	it("fails a service that crash-loops even when a sample catches it running", async () => {
		state.stableSamples = 3;
		state.psSeq = [
			line("db", "running", 0) + line("functions", "running", 0),
			line("db", "running", 0) + line("functions", "restarting", 1),
			line("db", "running", 0) + line("functions", "running", 2),
			line("db", "running", 0) + line("functions", "restarting", 3),
		];
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(false);
		expect(state.row.lastErrorCode).toBe("APP_RESTART_LOOP");
		expect(state.row.lastErrorParams).toMatchObject({
			service: "functions",
			restarts: 3,
		});
		expect(codes()).not.toContain("deploy.running");
	});

	it("keeps the stored overrides encrypted as they were", async () => {
		// Identity crypto in this file: the "cipher" is the JSON itself.
		const sealed = JSON.stringify({ A: "1" });
		state.row.inputs = { overridesEncrypted: sealed, stoppedServices: ["db"] };
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(true);
		const inputs = state.row.inputs as Record<string, unknown>;
		expect(inputs.overridesEncrypted).toBe(sealed);
		expect(inputs).not.toHaveProperty("overrides");
		expect(inputs.templateKeys).toEqual(expect.any(Array));
		expect(inputs.stoppedServices).toBeUndefined();
	});

	it("succeeds with a warning naming a service that restarted once", async () => {
		state.stableSamples = 3;
		state.psSeq = [
			line("db", "running", 0) + line("functions", "running", 0),
			line("db", "running", 0) + line("functions", "restarting", 1),
			line("db", "running", 0) + line("functions", "running", 1),
		];
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(true);
		expect(state.events).toContainEqual({
			code: "job.warning",
			params: {
				warning: {
					$error: {
						code: "APP_SERVICES_RESTARTED",
						params: { services: { $list: ["functions (↻1)"] } },
						text: null,
					},
				},
			},
		});
	});
});

describe("transient unhealthy healthcheck (BUG-011)", () => {
	const line = (service: string, health: string) =>
		`${service}\trunning\t0\t0\t${health}\n`;

	it("does not fail the deploy on one unhealthy sample", async () => {
		state.psSeq = [
			line("db", "healthy") + line("storage", "starting"),
			line("db", "healthy") + line("storage", "unhealthy"),
			line("db", "healthy") + line("storage", "healthy"),
		];
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(true);
	});

	it("reports a service still unhealthy at the deadline as unhealthy", async () => {
		state.ps = line("db", "healthy") + line("storage", "unhealthy");
		state.timeoutMs = 20;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(false);
		expect(state.row.lastErrorCode).toBe("APP_UNHEALTHY");
	});

	it("fails once the grace window is over", async () => {
		state.ps = line("db", "healthy") + line("storage", "unhealthy");
		state.unhealthyGraceMs = 0;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(false);
		expect(state.row.lastErrorCode).toBe("APP_UNHEALTHY");
	});
});

describe("pending env (stored before upload, not live yet)", () => {
	const templateKeys = () =>
		(state.row.inputs as { templateKeys?: string[] }).templateKeys ?? [];
	const row = () => state.row as never;

	it("marks a failed first deploy's values pending until a deploy succeeds", async () => {
		state.failPull = true;
		await runDeploy("app-1", "deploy", undefined, ctx());
		expect(state.row.envPendingAt).toBeInstanceOf(Date);
		// Never deployed: nothing runs.
		expect(state.row.envDeployedEncrypted).toBeNull();
		expect(deployedEnvValues(row())).toEqual({});

		state.failPull = false;
		await runDeploy("app-1", "deploy", undefined, ctx());
		expect(state.row.envPendingAt).toBeNull();
		expect(state.row.envDeployedEncrypted).toBeNull();
		expect(deployedEnvValues(row())).toEqual(storedEnv());
	});

	it("rolls a failed update back to the previous version's env and template keys", async () => {
		await runDeploy("app-1", "deploy", undefined, ctx());
		const live = storedEnv();
		expect(state.row.envPendingAt).toBeNull();

		// The update (v2 adds NEW_KEY) fails after its files were written.
		state.failPull = true;
		await runDeploy("app-1", "update", "v2", ctx());
		expect(storedEnv()).toHaveProperty("NEW_KEY");
		expect(templateKeys()).toContain("NEW_KEY");
		expect(state.row.envPendingAt).toBeInstanceOf(Date);
		// Update previews diff against what runs, not the failed version.
		expect(deployedEnvValues(row())).toEqual(live);

		// Rollback (redeploy of the previous version) fails too after upload:
		// the stored state matches its files, not the failed version's.
		await runDeploy("app-1", "redeploy", undefined, ctx());
		expect(storedEnv()).not.toHaveProperty("NEW_KEY");
		expect(templateKeys()).not.toContain("NEW_KEY");
		expect(storedEnv().POSTGRES_PASSWORD).toBe(live.POSTGRES_PASSWORD);
		expect(deployedEnvValues(row())).toEqual(live);

		state.failPull = false;
		await runDeploy("app-1", "redeploy", undefined, ctx());
		expect(state.row.envPendingAt).toBeNull();
		expect(templateKeys()).not.toContain("NEW_KEY");
		expect(storedEnv()).toEqual(live);
	});

	it("previews an update against the deployed env, not a failed one's", async () => {
		const { previewAppUpdate } = await import("./app-jobs.server");
		const { withImplied } = await import("#/config/permissions.ts");
		const actor = {
			userId: null,
			teamId: "team-1",
			role: null,
			permissions: new Set(withImplied(["app.view"])),
			instanceAdmin: false,
			via: "token" as const,
			tokenId: "t1",
		} as never;
		state.row.teamId = "team-1";
		await runDeploy("app-1", "deploy", undefined, ctx());
		state.failPull = true;
		await runDeploy("app-1", "update", "v2", ctx());
		// The failed v2 stored NEW_KEY; v2 is still an addition to what runs.
		const preview = await previewAppUpdate(actor, "app-1", "v2");
		expect(JSON.stringify(preview.env)).toContain("NEW_KEY");
		expect(preview.env).toMatchObject({ added: ["NEW_KEY"] });
		expect(preview.downgrade).toBeNull();
	});
});

describe("changing to an older version (BUG-022)", () => {
	const actor = {
		userId: null,
		teamId: "team-1",
		role: null,
		permissions: new Set(["app.view", "app.deploy"]),
		instanceAdmin: false,
		via: "token" as const,
		tokenId: "t1",
	} as never;
	const warningCodes = (preview: { warnings: { code: string | null }[] }) =>
		preview.warnings.map((warning) => warning.code);

	beforeEach(async () => {
		state.row.teamId = "team-1";
		await runDeploy("app-1", "deploy", undefined, ctx());
		state.row.version = "2.4.5";
	});

	it("warns first in the preview, stronger with irreversible migrations", async () => {
		const { previewAppUpdate } = await import("./app-jobs.server");
		const preview = await previewAppUpdate(actor, "app-1", "2.3.0");
		expect(preview.downgrade).toBe("downgrade");
		expect(warningCodes(preview)[0]).toBe("APP_DOWNGRADE_WARN");
		expect(preview.warnings[0]?.params).toEqual({
			from: "2.4.5",
			to: "2.3.0",
		});

		state.templateManifest.updates = { rollback: "restore" };
		const strong = await previewAppUpdate(actor, "app-1", "2.3.0");
		expect(strong.downgrade).toBe("irreversible");
		expect(warningCodes(strong)[0]).toBe("APP_DOWNGRADE_WARN_IRREVERSIBLE");
	});

	it("makes no claim for upgrades or unordered version sources", async () => {
		const { previewAppUpdate } = await import("./app-jobs.server");
		const upgrade = await previewAppUpdate(actor, "app-1", "2.5.0");
		expect(upgrade.downgrade).toBeNull();
		expect(warningCodes(upgrade)).not.toContain("APP_DOWNGRADE_WARN");

		state.templateManifest.source = { versions: "branches" };
		const branch = await previewAppUpdate(actor, "app-1", "2.3.0");
		expect(branch.downgrade).toBeNull();
	});

	it("refuses an unconfirmed downgrade on the server", async () => {
		const { startAppAction } = await import("./app-jobs.server");
		state.audits = [];
		await expect(
			startAppAction(actor, {
				appId: "app-1",
				action: "update",
				version: "2.3.0",
			}),
		).rejects.toMatchObject({
			code: "APP_DOWNGRADE_UNCONFIRMED",
			params: { from: "2.4.5", to: "2.3.0" },
		});
		await expect(
			startAppAction(actor, {
				appId: "app-1",
				action: "update",
				version: "2.3.0",
				confirmDowngrade: false,
			}),
		).rejects.toMatchObject({ code: "APP_DOWNGRADE_UNCONFIRMED" });
		// Refused before anything is recorded.
		expect(state.audits).toEqual([]);
	});
});

describe("a failed first deploy keeps its generated secrets", () => {
	it("stores the values before the .env reaches the server", async () => {
		state.failPull = true;
		const first = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(first.success).toBe(false);
		expect(state.row.status).toBe("error");
		// Not marked deployed, but the env matches the server's .env.
		expect(state.row.composeDeployed).toBeNull();
		expect(storedEnv()).toEqual(await serverEnv());
		const firstPassword = storedEnv().POSTGRES_PASSWORD;

		state.failPull = false;
		state.events = [];
		state.commands = [];
		const second = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(second.success).toBe(true);
		expect(storedEnv().POSTGRES_PASSWORD).toBe(firstPassword);
		expect((await serverEnv()).POSTGRES_PASSWORD).toBe(firstPassword);
		expect(state.row.status).toBe("running");
		// Stored env: no probe of the server.
		expect(state.commands.some((c) => c.includes('echo "owner='))).toBe(false);
	});

	it("recovers the values from the server's .env when none are stored", async () => {
		// An interrupted first deploy from before the fix: files on the
		// server, nothing stored.
		state.failPull = true;
		await runDeploy("app-1", "deploy", undefined, ctx());
		const onServer = await serverEnv();
		state.row.envEncrypted = null;
		state.failPull = false;
		state.events = [];

		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(true);
		expect(storedEnv().POSTGRES_PASSWORD).toBe(onServer.POSTGRES_PASSWORD);
		expect(storedEnv().JWT_SECRET).toBe(onServer.JWT_SECRET);
		expect(state.events).toContainEqual({
			code: "deploy.env_recovered",
			params: { count: 2 },
		});
		expect(codes()).not.toContain("deploy.secrets_new_with_data");
		// The recovered secrets are never logged.
		expect(JSON.stringify(state.events)).not.toContain(
			onServer.POSTGRES_PASSWORD,
		);
	});

	it("never reads the .env of a folder another instance owns", async () => {
		state.files.set(`${APP_ROOT}/.nitrobase-instance`, "other-panel\n");
		state.files.set(`${APP_ROOT}/.env`, "POSTGRES_PASSWORD='foreign'\n");
		state.failPull = true;
		await runDeploy("app-1", "deploy", undefined, ctx());
		expect(storedEnv().POSTGRES_PASSWORD).not.toBe("foreign");
		expect(codes()).not.toContain("deploy.env_recovered");
	});

	it("warns when new secrets meet existing data", async () => {
		state.volumes = 1;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(true);
		expect(codes()).toContain("deploy.secrets_new_with_data");
	});

	it("checks data bind folders (not rendered config) without volumes", async () => {
		await runDeploy("app-1", "deploy", undefined, ctx());
		const probe = state.commands.find((c) => c.includes('echo "data='));
		expect(probe).toContain(`${APP_ROOT}/volumes/db/data`);
		expect(probe).not.toContain("init.sql");
		expect(codes()).not.toContain("deploy.secrets_new_with_data");
	});
});

describe("bind-mounted files and pull progress", () => {
	it("refuses before `up` when a file bind is not a file on the server", async () => {
		state.fileMissing = true;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(false);
		expect(state.row.lastErrorCode).toBe("TEMPLATE_BIND_SOURCE_MISSING");
		expect(state.row.lastErrorParams).toEqual({
			service: "db",
			path: "volumes/db/init.sql",
		});
		// Never started (Docker would have mounted an empty folder).
		expect(state.commands.some((c) => c.includes(" up -d"))).toBe(false);
		// The data folder is still created, the file bind never is.
		const check = state.commands.find((c) => c.includes("bind-file-missing="));
		expect(check).toContain(`mkdir -p -- '${APP_ROOT}/volumes/db/data'`);
		expect(check).not.toContain(
			`mkdir -p -- '${APP_ROOT}/volumes/db/init.sql'`,
		);
	});

	it("only warns before `up` about a file-named bind nothing writes (owner's ./config.json)", async () => {
		state.namedConfig = true;
		state.configPresent = true;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(true);
		expect(codes()).not.toContain("deploy.bind_file_warning");
		expect(state.commands.some((c) => c.includes(" up -d"))).toBe(true);
	});

	it("warns, deploys, then refuses Docker's empty folder after `up`", async () => {
		state.namedConfig = true;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(state.events).toContainEqual({
			code: "deploy.bind_file_warning",
			params: { service: "db", path: "config.json" },
		});
		// Started (the deploy used to work this way)...
		expect(state.commands.some((c) => c.includes(" up -d"))).toBe(true);
		// ...but an empty folder in place of the file fails it, explained.
		expect(outcome.success).toBe(false);
		expect(state.row.lastErrorCode).toBe("TEMPLATE_BIND_SOURCE_MISSING");
		expect(state.row.lastErrorParams).toEqual({
			service: "db",
			path: "config.json",
		});
	});

	it("replaces an empty folder Docker left where a file is written", async () => {
		state.emptyDir = true;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(true);
		expect(state.events).toContainEqual({
			code: "deploy.empty_dir_replaced",
			params: { path: `${APP_ROOT}/volumes/db/init.sql` },
		});
		expect(state.files.has(`${APP_ROOT}/volumes/db/init.sql`)).toBe(true);
	});

	it("logs a heartbeat while images are pulled", async () => {
		state.heartbeatMs = 5;
		state.pullDelayMs = 40;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(true);
		const beats = state.events.filter((e) => e.code === "deploy.pull_progress");
		expect(beats.length).toBeGreaterThan(0);
		expect(beats[0].params).toMatchObject({
			elapsed: { $ms: expect.any(Number) },
		});
		// Stops with the pull: none once the containers start.
		const started = codes().indexOf("deploy.starting");
		expect(codes().lastIndexOf("deploy.pull_progress")).toBeLessThan(started);
	});
});

describe("initial_only values freeze once a deploy reaches compose up (BUG-014)", () => {
	const initialised = () =>
		(state.row.inputs as { initialised?: string[] }).initialised;

	it("a first deploy that fails at or after up still marks the app initialised", async () => {
		state.failUp = true;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(false);
		expect(state.row.composeDeployed).toBeNull();
		expect(initialised()).toEqual(["POSTGRES_PASSWORD"]);
	});

	it("a first deploy that fails before up does not", async () => {
		state.failPull = true;
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(false);
		expect(state.commands.some((c) => c.includes(" up -d"))).toBe(false);
		expect(initialised()).toBeUndefined();
	});

	it("later deploys keep the first marker", async () => {
		state.row.inputs = { overrides: {}, initialised: [] };
		const outcome = await runDeploy("app-1", "deploy", undefined, ctx());
		expect(outcome.success).toBe(true);
		expect(initialised()).toEqual([]);
	});
});
