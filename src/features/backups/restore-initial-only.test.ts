import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Restore and `initial_only` credentials (OneDev #11, BUG-014): the
 * restored data holds the current admin login, so the dialog says so
 * instead of promising the copied env value works, and the restored app
 * counts as initialised with the archive's values.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));
vi.mock("#/db/index.ts", () => ({ db: {} }));
vi.mock("#/server/services/audit.ts", () => ({ audit: () => {} }));

const state = vi.hoisted(() => ({
	backup: {} as Record<string, unknown>,
	patches: [] as Record<string, unknown>[],
	manifestVersions: [] as (string | undefined)[],
}));

vi.mock("./backups.server", async (importOriginal) => ({
	...(await importOriginal<typeof import("./backups.server")>()),
	getBackupRow: async () => ({ ...state.backup }),
}));

const variables = {
	PB_ADMIN_EMAIL: {
		value: "admin@${domain}",
		label: "Admin email",
		credential: true,
		editable: true,
		initial_only: true,
	},
	PB_ADMIN_PASSWORD: {
		value: "${password:24}",
		label: "Admin password",
		credential: true,
		editable: true,
		initial_only: true,
	},
	OWNER_EMAIL: {
		value: "owner@${domain}",
		label: "Owner email",
		credential: true,
		editable: true,
	},
	SITE_URL: { value: "https://${domain}", label: "Site URL" },
};

/** A database app: its variables come from the engine its version names. */
const databaseVariables = {
	DB_USER: {
		value: "app",
		label: "Database user",
		credential: true,
		initial_only: true,
	},
	DB_PASSWORD: {
		value: "${password:32}",
		label: "Password",
		credential: true,
		initial_only: true,
	},
};

vi.mock("#/features/templates/templates.server.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("#/features/templates/templates.server.ts")
	>()),
	getTemplateManifest: async () => ({
		id: "pocketbase",
		name: "PocketBase",
		source: { type: "github", versions: "releases" },
		variables,
	}),
}));

vi.mock("#/features/apps/apps.server.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/features/apps/apps.server.ts")>()),
	getAppManifest: async (app: { templateId: string; version?: string }) => {
		state.manifestVersions.push(app.version);
		if (app.templateId !== "database") return { variables };
		return {
			variables: app.version?.startsWith("postgres@") ? databaseVariables : {},
		};
	},
}));

vi.mock("#/features/apps/app-jobs.server.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("#/features/apps/app-jobs.server.ts")
	>()),
	setStatus: async (_id: string, patch: Record<string, unknown>) => {
		state.patches.push(patch);
	},
}));

// No encryption key in tests: the plain text stands in for the cipher.
vi.mock("#/utils/crypto.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/utils/crypto.ts")>()),
	encrypt: (text: string) => text,
	decrypt: (text: string) => text,
}));

const { applyArchiveState, restoreClonePreview } = await import(
	"./restore.server"
);
const { appInputs, appOverrides } = await import(
	"#/features/apps/apps.server.ts"
);

beforeEach(() => {
	state.backup = {
		id: "b1",
		templateId: "pocketbase",
		version: "v0.30.0",
		customSpecEncrypted: null,
	};
	state.patches = [];
	state.manifestVersions = [];
});

describe("restore preview with initial_only credentials", () => {
	it("lists them as coming from the restored data, not as kept", async () => {
		const preview = await restoreClonePreview({ teamId: "t" } as never, "b1");
		expect(preview.fromData).toEqual([
			{ name: "PB_ADMIN_EMAIL", label: "Admin email" },
			{ name: "PB_ADMIN_PASSWORD", label: "Admin password" },
		]);
		expect(preview.kept).toEqual([
			{ name: "OWNER_EMAIL", label: "Owner email" },
		]);
		expect(preview.recomputed).toEqual([
			{ name: "SITE_URL", label: "Site URL" },
		]);
	});

	it("reads a database backup's engine variables (its version)", async () => {
		state.backup = {
			...state.backup,
			templateId: "database",
			version: "postgres@17",
		};
		const preview = await restoreClonePreview({ teamId: "t" } as never, "b1");
		expect(state.manifestVersions).toContain("postgres@17");
		expect(preview.fromData).toEqual([
			{ name: "DB_USER", label: "Database user" },
			{ name: "DB_PASSWORD", label: "Password" },
		]);
	});
});

describe("restored app state", () => {
	it("counts as initialised with the archive's initial_only values", async () => {
		await applyArchiveState(
			{
				id: "app-2",
				templateId: "pocketbase",
				version: "v0.30.0",
				envEncrypted: null,
				envPendingAt: null,
				envDeployedEncrypted: null,
				composeDeployed: null,
				inputs: { overrides: {} },
			} as never,
			{
				manifest: { template: { version: "v0.30.0", commitSha: "" } },
				env: {
					values: {
						PB_ADMIN_EMAIL: "admin@old.test",
						PB_ADMIN_PASSWORD: "p1",
						SITE_URL: "https://old.test",
					},
					overrides: {},
					serviceEnv: {},
					publishedPorts: {},
				},
			} as never,
			{ keepPorts: false, previousHost: "old.test" },
		);
		expect(appInputs(state.patches[0] as never)).toMatchObject({
			initialised: ["PB_ADMIN_EMAIL", "PB_ADMIN_PASSWORD"],
		});
		expect(appOverrides(state.patches[0] as never)).toEqual({
			PB_ADMIN_EMAIL: "admin@old.test",
		});
	});
});
