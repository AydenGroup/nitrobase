import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A restore whose deploy fails before it changed the server (render,
 * source fetch) puts the row back as it was: `applyArchiveState` had
 * already stored the archive's env, inputs and version, while the server
 * still runs the old ones (review of BUG-020). A deploy that reached the
 * server keeps the archive's state (the next redeploy converges on it).
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const state = vi.hoisted(() => ({
	row: {} as Record<string, unknown>,
	outcome: { success: false } as Record<string, unknown>,
	deployOptions: [] as unknown[],
}));

vi.mock("#/db/index.ts", () => ({ db: {} }));
vi.mock("#/utils/crypto.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/utils/crypto.ts")>()),
	encrypt: (text: string) => `enc:${text}`,
	decrypt: (text: string) => text.replace(/^enc:/, ""),
}));
vi.mock("#/features/apps/apps.server.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/features/apps/apps.server.ts")>()),
	getAppManifest: async () => ({ variables: {} }),
}));
vi.mock("#/features/apps/app-jobs.server.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("#/features/apps/app-jobs.server.ts")
	>()),
	setStatus: async (_id: string, patch: Record<string, unknown>) => {
		Object.assign(state.row, patch);
	},
	runDeploy: async (...args: unknown[]) => {
		state.deployOptions.push(args[4]);
		return state.outcome;
	},
}));

const { deployArchive } = await import("./restore.server");

const before = {
	id: "app-1",
	status: "running",
	envEncrypted: "old-env",
	envPendingAt: null,
	envDeployedEncrypted: null,
	serviceEnvEncrypted: "old-service-env",
	customSpecEncrypted: null,
	inputs: { publishedPorts: {}, overridesEncrypted: "enc:{}" },
	version: "1.0.0",
	commitSha: "a".repeat(40),
	needsRedeploy: false,
	composeDeployed: "services: {}\n",
};

const fetched = {
	manifest: {
		template: { version: "0.9.0", commitSha: "b".repeat(40) },
	},
	env: {
		values: { SECRET: "archived" },
		overrides: { ADMIN: "archived@example.org" },
		serviceEnv: {},
		publishedPorts: {},
		primaryHost: null,
	},
};

const restore = () =>
	deployArchive(
		before as never,
		fetched as never,
		{ clone: false, beforeUp: async () => {} },
		{} as never,
	);

beforeEach(() => {
	state.row = { ...before };
	state.deployOptions = [];
});

describe("restore whose deploy fails before touching the server", () => {
	it("puts back the row the archive's state replaced", async () => {
		state.outcome = { success: false, untouched: true };
		await restore();
		expect(state.row).toEqual(before);
	});

	it("keeps the archive's state once the deploy reached the server", async () => {
		state.outcome = { success: false, untouched: false };
		await restore();
		expect(state.row.version).toBe("0.9.0");
		expect(state.row.envPendingAt).toBeInstanceOf(Date);
	});

	it("runs the deploy nested (the restore's cancel state stands)", async () => {
		state.outcome = { success: true };
		await restore();
		expect(state.deployOptions).toEqual([
			expect.objectContaining({ nested: true }),
		]);
	});
});
