import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BUG-002 status model: a failed connection test never downgrades a Ready
 * (or bootstrapping) server, a failed re-bootstrap that never reached the
 * server keeps it Ready, and a new address starts over at `pending`. The
 * server row lives in memory; jobs run inline with a fake executor.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const state = vi.hoisted(() => ({
	row: {} as Record<string, unknown>,
	/** Answer of the fake SSH executor (an Error is thrown). */
	exec: null as null | Error | { stdout: string },
	/** Outcome of the (mocked) bootstrap itself. */
	bootstrap: null as null | Record<string, unknown>,
	outcome: null as null | { success: boolean },
	/** Executor calls made, and the call number from which `exec` fails. */
	execCalls: 0,
	failFrom: 0,
}));

vi.mock("#/db/index.ts", () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => {
					const rows = [{ ...state.row }];
					return Object.assign(Promise.resolve(rows), {
						limit: async () => rows,
					});
				},
			}),
		}),
		update: () => ({
			set: (patch: Record<string, unknown>) => ({
				where: () => {
					Object.assign(state.row, patch);
					return Object.assign(Promise.resolve(), {
						returning: async () => [{ ...state.row }],
					});
				},
			}),
		}),
	},
}));

vi.mock("#/config/server.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/config/server.ts")>()),
	traefikVersion: () => "v3.6.25",
}));

vi.mock("#/features/deployments/deployments.server.ts", () => ({
	isServerBusy: () => false,
	recoverOrphanedJobs: async () => {},
	startJob: async (
		_params: unknown,
		run: (ctx: unknown) => Promise<{ success: boolean }>,
	) => {
		state.outcome = await run({ deploymentId: "job-1", event: () => {} });
		return { deploymentId: "job-1" };
	},
}));

vi.mock("#/server/services/audit.ts", () => ({ audit: () => {} }));
vi.mock("#/features/monitoring/service.server.ts", () => ({
	serverHealthSummaries: async () => new Map(),
}));
vi.mock("#/features/settings/instance-identity.server.ts", () => ({
	requireInstanceId: async () => "inst-1",
}));
vi.mock("#/features/servers/tunnel.server.ts", () => ({
	convergeTunnel: async () => {},
}));
vi.mock("#/server/services/ssh-keygen.ts", () => ({
	generateSSHKey: async () => ({
		privateKey: "new",
		publicKey: "ssh-ed25519 AAAA",
	}),
}));
vi.mock("#/features/ssh_keys/ssh_keys.server.ts", () => ({
	getSSHKeyCredentials: async () => ({ privateKey: "key" }),
	createSSHKey: async () => ({ id: "managed" }),
	deleteSSHKey: async () => {},
}));

vi.mock("#/server/services/server-setup.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("#/server/services/server-setup.ts")
	>()),
	probeServerOwnership: async (executor: { exec: (c: string) => unknown }) => {
		await executor.exec("ownership");
		return { foreign: [] };
	},
	bootstrapServer: async () => state.bootstrap,
}));

vi.mock("#/server/services/ssh.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/services/ssh.ts")>();
	class FakeExecutor {
		kind = "ssh" as const;
		async exec() {
			state.execCalls++;
			if (state.failFrom && state.execCalls >= state.failFrom) {
				throw new actual.SshConnectionError("Connection lost");
			}
			if (state.exec instanceof Error) throw state.exec;
			return { stdout: state.exec?.stdout ?? "", stderr: "", exitCode: 0 };
		}
		close() {}
	}
	return { ...actual, SshExecutor: FakeExecutor };
});

import type { Actor } from "#/features/auth/access.ts";
import {
	HostKeyMismatchError,
	SshConnectionError,
} from "#/server/services/ssh.ts";
import { AppError } from "#/utils/error.ts";
import { startServerAction, updateServer } from "./servers.server";

const TEAM = "team-1";
const actor = {
	userId: "user-1",
	teamId: TEAM,
	role: "owner",
	permissions: new Set(["server.view", "server.manage"]),
	instanceAdmin: false,
	via: "session",
} as unknown as Actor;

const server = (status: string): Record<string, unknown> => ({
	id: "srv-1",
	teamId: TEAM,
	name: "box1",
	host: "10.0.0.5",
	port: 22,
	username: "root",
	authMethod: "private_key",
	sshKeyId: "key-1",
	passwordEncrypted: null,
	hostKeyFingerprint: "SHA256:old",
	isDefault: false,
	status,
	os: "Ubuntu 24.04",
	dockerVersion: "29.9.0",
	traefikVersion: "v3.6.25",
	lastError: null,
	lastErrorCode: null,
	lastErrorParams: null,
	tunnelEnabled: false,
	tunnelOnly: false,
});

const PROBE_OK = { stdout: "os=Ubuntu 24.04\ndocker=Docker version 29.9.0\n" };
const CONNECTION_DOWN = new SshConnectionError(
	"Timed out while waiting for handshake",
);

beforeEach(() => {
	state.exec = null;
	state.bootstrap = null;
	state.outcome = null;
	state.execCalls = 0;
	state.failFrom = 0;
});

describe("connection test status", () => {
	it.each([
		// [status before, test result, status after, last error recorded]
		["ready", "failure", "ready", true],
		["bootstrapping", "failure", "bootstrapping", true],
		["reachable", "failure", "unreachable", true],
		["pending", "failure", "unreachable", true],
		["ready", "success", "ready", false],
		["pending", "success", "reachable", false],
		["unreachable", "success", "reachable", false],
	] as const)("%s + %s → %s", async (before, result, after, recorded) => {
		state.row = server(before);
		state.exec = result === "success" ? PROBE_OK : CONNECTION_DOWN;
		await startServerAction(actor, "srv-1", "connection_test", "");
		expect(state.outcome?.success).toBe(result === "success");
		expect(state.row.status).toBe(after);
		expect(!!state.row.lastError).toBe(recorded);
		if (recorded) expect(state.row.lastErrorCode).toBeTruthy();
	});

	it("keeps a Ready server Ready on a host key mismatch, recording the code", async () => {
		state.row = server("ready");
		state.exec = new HostKeyMismatchError("SHA256:old", "SHA256:new");
		await startServerAction(actor, "srv-1", "connection_test", "");
		expect(state.row).toMatchObject({
			status: "ready",
			lastErrorCode: "HOST_KEY_MISMATCH",
		});
	});

	it("clears the last error of a Ready server once a test succeeds", async () => {
		state.row = { ...server("ready"), lastError: "old", lastErrorCode: "X" };
		state.exec = PROBE_OK;
		await startServerAction(actor, "srv-1", "connection_test", "");
		expect(state.row).toMatchObject({
			status: "ready",
			lastError: null,
			lastErrorCode: null,
		});
	});
});

describe("re-bootstrap of a Ready server", () => {
	const failed = (error: unknown, changed: boolean) => ({
		success: false,
		steps: [],
		error,
		os: null,
		dockerVersion: null,
		changed,
	});

	it("stays Ready when the server could not be reached before any change", async () => {
		state.row = server("ready");
		state.bootstrap = failed(CONNECTION_DOWN, false);
		await startServerAction(actor, "srv-1", "bootstrap", "me@example.com");
		expect(state.outcome?.success).toBe(false);
		expect(state.row.status).toBe("ready");
		expect(state.row.lastErrorCode).toBe("SSH_CONNECTION_FAILED");
	});

	it("is Error when the connection dropped after bootstrap changed the server", async () => {
		state.row = server("ready");
		state.bootstrap = failed(CONNECTION_DOWN, true);
		await startServerAction(actor, "srv-1", "bootstrap", "me@example.com");
		expect(state.row.status).toBe("error");
	});

	it("is Error for a real bootstrap failure, even before any change", async () => {
		state.row = server("ready");
		state.bootstrap = failed(new AppError("SETUP_PORTS_BUSY"), false);
		await startServerAction(actor, "srv-1", "bootstrap", "me@example.com");
		expect(state.row.status).toBe("error");
	});

	it("stays Ready when the job's own ownership probe cannot connect", async () => {
		state.row = server("ready");
		// Call 1: the up-front probe of startServerAction; call 2: the job's.
		state.failFrom = 2;
		await startServerAction(actor, "srv-1", "bootstrap", "me@example.com");
		expect(state.outcome?.success).toBe(false);
		expect(state.row.status).toBe("ready");
	});

	it("is Error when the managed key switch lost the connection (may have changed)", async () => {
		state.row = {
			...server("ready"),
			authMethod: "password",
			sshKeyId: null,
			passwordEncrypted: null,
		};
		// Calls 1-2: ownership probes; call 3: installing the managed key.
		state.failFrom = 3;
		await startServerAction(actor, "srv-1", "bootstrap", "me@example.com");
		expect(state.execCalls).toBe(3);
		expect(state.row.status).toBe("error");
	});

	it("marks a not-yet-ready server Unreachable when it cannot be reached", async () => {
		state.row = server("reachable");
		state.bootstrap = failed(CONNECTION_DOWN, false);
		await startServerAction(actor, "srv-1", "bootstrap", "me@example.com");
		expect(state.row.status).toBe("unreachable");
	});
});

describe("updateServer", () => {
	it("sends a Ready server back to pending when its address changes", async () => {
		state.row = { ...server("ready"), lastError: "old" };
		const updated = await updateServer(actor, "srv-1", { host: "10.0.0.9" });
		expect(updated).toMatchObject({
			host: "10.0.0.9",
			status: "pending",
			hostKeyFingerprint: null,
			lastError: null,
		});
	});

	it("keeps the status when only the name changes", async () => {
		state.row = server("ready");
		const updated = await updateServer(actor, "srv-1", { name: "box-renamed" });
		expect(updated).toMatchObject({
			status: "ready",
			hostKeyFingerprint: "SHA256:old",
		});
	});

	it("treats a new port as a new target too", async () => {
		state.row = server("ready");
		expect((await updateServer(actor, "srv-1", { port: 2222 })).status).toBe(
			"pending",
		);
	});
});
