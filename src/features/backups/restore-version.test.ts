import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Restore and the template's `min_version` (BUG-005 follow-up): a new app
 * cannot be made from a backup of a version below the floor (refused
 * before any job, with a way forward); restoring over the existing app
 * redeploys its pinned commit and stays possible.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const state = vi.hoisted(() => ({
	backup: {} as Record<string, unknown>,
	created: 0,
	jobs: 0,
}));

vi.mock("#/db/index.ts", () => ({ db: {} }));
vi.mock("#/server/services/audit.ts", () => ({ audit: () => {} }));

vi.mock("./backups.server", async (importOriginal) => ({
	...(await importOriginal<typeof import("./backups.server")>()),
	getBackupRow: async () => ({ ...state.backup }),
}));
vi.mock("./destinations.server", () => ({
	getDestinationRow: async () => ({ id: "dest", type: "s3" }),
	pickServer: async () => null,
}));

vi.mock("#/features/templates/templates.server.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("#/features/templates/templates.server.ts")
	>()),
	getTemplateManifest: async () => ({
		id: "supabase",
		name: "Supabase",
		source: { type: "github", versions: "releases", min_version: "v1.26.07" },
		variables: {},
	}),
}));

vi.mock("#/features/apps/apps.server.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/features/apps/apps.server.ts")>()),
	getAppRow: async () => ({ id: "app-1", folder: "supabase-0123abcd" }),
	assertDeleteConfirmation: () => {},
	readCustomSpec: () => null,
	getAppManifest: async () => ({ variables: {} }),
	createAppRecord: async () => {
		state.created++;
		return { id: "app-2", serverId: "srv" };
	},
}));

vi.mock("#/features/apps/app-jobs.server.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("#/features/apps/app-jobs.server.ts")
	>()),
	startAppJob: async () => {
		state.jobs++;
		return { deploymentId: "dep-1" };
	},
}));

const { startRestore, restoreClonePreview } = await import("./restore.server");

const actor = { teamId: "team" } as never;
const clone = {
	id: "b1",
	mode: "clone" as const,
	serverId: "00000000-0000-4000-8000-0000000000ab",
	name: "Restored",
};

beforeEach(() => {
	state.backup = {
		id: "b1",
		status: "success",
		kind: "app",
		appId: "app-1",
		serverId: "srv",
		destinationId: "dest",
		templateId: "supabase",
		version: "v1.26.05",
		customSpecEncrypted: null,
	};
	state.created = 0;
	state.jobs = 0;
});

describe("restore below the template's min_version", () => {
	it("refuses a new app before creating anything", async () => {
		await expect(startRestore(actor, clone)).rejects.toMatchObject({
			code: "BACKUP_RESTORE_VERSION_UNSUPPORTED",
			params: {
				template: "Supabase",
				version: "v1.26.05",
				minVersion: "v1.26.07",
			},
		});
		expect(state.created).toBe(0);
		expect(state.jobs).toBe(0);
	});

	it("tells the restore modal up front", async () => {
		expect((await restoreClonePreview(actor, "b1")).blocked).toMatchObject({
			code: "BACKUP_RESTORE_VERSION_UNSUPPORTED",
		});
		state.backup.version = "v1.26.08";
		expect((await restoreClonePreview(actor, "b1")).blocked).toBeNull();
	});

	it("still restores over the existing app (its pinned commit)", async () => {
		await startRestore(actor, {
			id: "b1",
			mode: "overwrite",
			confirmName: "supabase-0123abcd",
		});
		expect(state.jobs).toBe(1);
	});

	it("clones a backup of a supported version", async () => {
		state.backup.version = "v1.26.08";
		await startRestore(actor, clone);
		expect(state.created).toBe(1);
		expect(state.jobs).toBe(1);
	});
});
