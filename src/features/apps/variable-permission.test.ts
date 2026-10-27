import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Permission } from "#/config/permissions.ts";

/**
 * Template variables with a `permission` (e.g. the Supabase JSR mirror,
 * whose code runs with the app's secrets) need it besides the edit
 * permission: the env editor and the deploy form refuse without it.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const TEAM = "00000000-0000-4000-8000-0000000000aa";
const APP = "00000000-0000-4000-8000-0000000000ab";
const state = vi.hoisted(() => ({
	row: {} as Record<string, unknown>,
	updates: [] as Record<string, unknown>[],
}));

vi.mock("#/db/index.ts", () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [{ ...state.row }] }),
			}),
		}),
		update: () => ({
			set: (patch: Record<string, unknown>) => ({
				where: async () => {
					state.updates.push(patch);
				},
			}),
		}),
	},
}));

vi.mock(
	"#/features/deployments/deployments.server.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("#/features/deployments/deployments.server.ts")
		>()),
		withAppServerLock: (_app: unknown, step: () => Promise<unknown>) => step(),
	}),
);

vi.mock("#/server/services/audit.ts", () => ({ audit: () => {} }));

vi.mock("#/features/templates/templates.server.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("#/features/templates/templates.server.ts")
	>()),
	getTemplateManifest: async () => ({
		id: "demo",
		source: { type: "github" },
		variables: {
			MIRROR: {
				value: "",
				editable: true,
				type: "string",
				permission: "app.terminal",
			},
			SITE: { value: "x", editable: true, type: "string" },
			GEN: { value: "${password:16}", type: "string", rotatable: true },
			TOKEN: { value: "${jwt:GEN:anon}", type: "string" },
			// Generated, but the owner may choose it (e.g. an admin password).
			KEY: { value: "${password:16}", editable: true, type: "string" },
			SIGNED: { value: "${jwt:KEY:anon}", type: "string" },
		},
	}),
}));

vi.mock("./sources.server", () => ({
	sourceDriver: async () => ({
		manifest: async (manifest: unknown) => manifest,
	}),
}));

// No encryption key in tests: the plain text stands in for the cipher.
vi.mock("#/utils/crypto.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/utils/crypto.ts")>()),
	encrypt: (text: string) => text,
	decrypt: (text: string) => text,
}));

const { withImplied } = await import("#/config/permissions.ts");
const {
	appInputs,
	envVersion,
	getAppEnv,
	updateAppEnv,
	assertVariablePermissions,
} = await import("./apps.server");

/** The overrides a save stored (decrypted). */
function storedOverrides(patch: Record<string, unknown>) {
	return appInputs(patch as never).overrides;
}

function actor(granted: Permission[]) {
	return {
		userId: null,
		teamId: TEAM,
		role: null,
		permissions: new Set(withImplied(granted)),
		instanceAdmin: false,
		via: "token" as const,
		tokenId: "t1",
	} as never;
}

beforeEach(() => {
	state.row = {
		id: APP,
		teamId: TEAM,
		templateId: "demo",
		envEncrypted: JSON.stringify({ MIRROR: "", SITE: "x" }),
		envPendingAt: null,
		envDeployedEncrypted: null,
		inputs: { overrides: {} },
		needsRedeploy: false,
	};
	state.updates = [];
});

/** A save of `set`/`remove`/`reset` against the current stored env. */
function edit(
	changes: {
		set?: Record<string, string>;
		remove?: string[];
		reset?: string[];
	},
	version = envVersion(state.row as never),
) {
	return {
		set: changes.set ?? {},
		remove: changes.remove ?? [],
		reset: changes.reset ?? [],
		version,
	};
}

describe("variables with a template permission", () => {
	it("env editor: refuses to set it without the permission", async () => {
		await expect(
			updateAppEnv(
				actor(["app.env.edit"]),
				APP,
				edit({ set: { MIRROR: "https://m.test/jsr" } }),
			),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			params: { permission: "app.terminal" },
		});
		expect(state.updates).toEqual([]);
	});

	it("env editor: other variables stay editable", async () => {
		await updateAppEnv(
			actor(["app.env.edit"]),
			APP,
			edit({ set: { SITE: "y" } }),
		);
		expect(state.updates).toHaveLength(1);
	});

	it("env editor: allows it with the permission", async () => {
		await updateAppEnv(
			actor(["app.env.edit", "app.terminal"]),
			APP,
			edit({ set: { MIRROR: "https://m.test/jsr" } }),
		);
		expect(storedOverrides(state.updates[0])).toMatchObject({
			MIRROR: "https://m.test/jsr",
		});
	});

	it("deploy form check: only variables being set count", () => {
		const variables = { MIRROR: { permission: "app.terminal" as const } };
		expect(() =>
			assertVariablePermissions(actor(["app.deploy"]), variables, ["MIRROR"]),
		).toThrow();
		expect(() =>
			assertVariablePermissions(actor(["app.deploy"]), variables, ["SITE"]),
		).not.toThrow();
		expect(() =>
			assertVariablePermissions(
				actor(["app.deploy", "app.terminal"]),
				variables,
				["MIRROR"],
			),
		).not.toThrow();
	});
});

describe("env editor: changed variables only", () => {
	beforeEach(() => {
		state.row = {
			...state.row,
			envEncrypted: JSON.stringify({
				SITE: "x",
				SECRET_KEY: "new",
				EXTRA: "1",
			}),
			inputs: { overrides: { SECRET_KEY: "new", EXTRA: "1" } },
		};
	});

	it("never rewrites variables it was not sent", async () => {
		await updateAppEnv(
			actor(["app.env.edit"]),
			APP,
			edit({ set: { SITE: "y" } }),
		);
		expect(storedOverrides(state.updates[0])).toMatchObject({
			SECRET_KEY: "new",
			EXTRA: "1",
			SITE: "y",
		});
	});

	it("deletes removed custom variables and adds new ones", async () => {
		const view = await updateAppEnv(
			actor(["app.env.edit"]),
			APP,
			edit({ set: { ADDED: "a" }, remove: ["EXTRA"] }),
		);
		expect(view.changed).toEqual(["ADDED", "EXTRA"]);
		expect(storedOverrides(state.updates[0])).toMatchObject({
			SECRET_KEY: "new",
			ADDED: "a",
		});
	});

	it("refuses a save based on an older env", async () => {
		const stale = envVersion(state.row as never);
		state.row = { ...state.row, envEncrypted: JSON.stringify({ SITE: "z" }) };
		await expect(
			updateAppEnv(
				actor(["app.env.edit"]),
				APP,
				edit({ set: { SITE: "y" } }, stale),
			),
		).rejects.toMatchObject({ code: "ENV_CHANGED_SINCE_LOAD" });
		expect(state.updates).toEqual([]);
	});

	it("refuses the secret mask as a value", async () => {
		await expect(
			updateAppEnv(
				actor(["app.env.edit"]),
				APP,
				edit({ set: { ADDED: "********" } }),
			),
		).rejects.toMatchObject({ code: "ENV_VALUE_MASKED" });
	});
});

describe("env editor: reset to the template", () => {
	beforeEach(() => {
		state.row = {
			...state.row,
			envEncrypted: JSON.stringify({
				MIRROR: "https://m.test/jsr",
				SITE: "mine",
				KEY: "owner-chosen-password",
				SIGNED: "signed-override",
				EXTRA: "1",
			}),
			inputs: {
				overrides: {
					MIRROR: "https://m.test/jsr",
					SITE: "mine",
					KEY: "owner-chosen-password",
					SIGNED: "signed-override",
					EXTRA: "1",
				},
			},
		};
	});

	it("drops the override and stored value of a plain variable", async () => {
		const view = await updateAppEnv(
			actor(["app.env.edit"]),
			APP,
			edit({ reset: ["SITE"] }),
		);
		expect(view.changed).toEqual(["SITE"]);
		expect(state.updates[0]).toMatchObject({ needsRedeploy: true });
		const stored = JSON.parse(state.updates[0].envEncrypted as string);
		expect(stored).not.toHaveProperty("SITE");
		expect(storedOverrides(state.updates[0])).not.toHaveProperty("SITE");
	});

	it("keeps a generated variable's exact value and its dependents' overrides", async () => {
		await updateAppEnv(actor(["app.env.edit"]), APP, edit({ reset: ["KEY"] }));
		const update = state.updates[0];
		expect(JSON.parse(update.envEncrypted as string).KEY).toBe(
			"owner-chosen-password",
		);
		const overrides = storedOverrides(update);
		expect(overrides).not.toHaveProperty("KEY");
		expect(overrides.SIGNED).toBe("signed-override");
		// Nothing changes on the next deploy.
		expect(update.needsRedeploy).toBe(false);
	});

	it("needs the variable's permission", async () => {
		await expect(
			updateAppEnv(actor(["app.env.edit"]), APP, edit({ reset: ["MIRROR"] })),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			params: { permission: "app.terminal" },
		});
		expect(state.updates).toEqual([]);
	});

	it("ignores custom variables (delete them instead)", async () => {
		const view = await updateAppEnv(
			actor(["app.env.edit"]),
			APP,
			edit({ reset: ["EXTRA"] }),
		);
		expect(view.changed).toEqual([]);
		expect(state.updates).toEqual([]);
	});
});

describe("env editor view", () => {
	it("describes variables in template order with their metadata", async () => {
		state.row = {
			...state.row,
			envEncrypted: JSON.stringify({
				EXTRA: "1",
				SITE: "x",
				GEN: "g",
				MIRROR: "",
			}),
			inputs: { overrides: { SITE: "x", EXTRA: "1" } },
		};
		const view = await getAppEnv(actor(["app.view"]), APP);
		expect(view.version).toBe(envVersion(state.row as never));
		expect(view.variables.map((variable) => variable.name)).toEqual([
			"MIRROR",
			"SITE",
			"GEN",
			"EXTRA",
		]);
		expect(view.variables[0]).toMatchObject({
			template: true,
			permission: "app.terminal",
			overridden: false,
			locked: false,
			generated: false,
		});
		expect(view.variables[1]).toMatchObject({ overridden: true });
		expect(view.variables[2]).toMatchObject({
			generated: true,
			rotatable: true,
			locked: true,
		});
		expect(view.variables[3]).toMatchObject({
			template: false,
			overridden: false,
			locked: false,
		});
	});
});
