import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Permission } from "#/config/permissions.ts";

/**
 * The env editor's values (`apps.inputs` overrides) hold user-set secrets
 * (e.g. an SMTP password): they are stored encrypted like `env_encrypted`
 * (BUG-018).
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const KEY = "test-secret-0123456789abcdefghijklmnop";
const NEW_KEY = "next-secret-0123456789abcdefghijklmnop";
const TEAM = "00000000-0000-4000-8000-0000000000aa";
const APP = "00000000-0000-4000-8000-0000000000ab";
const SMTP_PASSWORD = "smtp-pass-6f1d2c";

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
					state.row = { ...state.row, ...patch };
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
			SMTP_HOST: { value: "", editable: true, type: "string" },
			SMTP_PASSWORD: {
				value: "",
				editable: true,
				secret: true,
				type: "string",
			},
			// Locked: changing it would make the stored data unreadable.
			OPENSSL_KEY: {
				value: "${password:32}",
				secret: true,
				rotatable: true,
				type: "string",
			},
			SESSION_TOKEN: { value: "${jwt:OPENSSL_KEY:anon}", type: "string" },
			ADMIN_PASSWORD: {
				value: "${password:16}",
				editable: true,
				secret: true,
				type: "string",
			},
		},
	}),
}));

vi.mock("./sources.server", () => ({
	sourceDriver: async () => ({
		manifest: async (manifest: unknown) => manifest,
	}),
}));

vi.stubEnv("ENCRYPTION_KEY", KEY);

const { withImplied } = await import("#/config/permissions.ts");
const { encryptedColumns } = await import("#/db/encrypted-columns.ts");
const { reencryptAll } = await import("#/db/reencrypt.ts");
const { apps } = await import("#/db/schema/apps.ts");
const { encrypt } = await import("#/utils/crypto.ts");
const { appInputs, envVersion, getAppEnv, storedAppInputs, updateAppEnv } =
	await import("./apps.server");

const editor = {
	userId: null,
	teamId: TEAM,
	role: null,
	permissions: new Set(withImplied(["app.env.edit"] as Permission[])),
	instanceAdmin: false,
	via: "token" as const,
	tokenId: "t1",
} as never;

const deployed = {
	SMTP_HOST: "smtp.test",
	SMTP_PASSWORD: "",
	OPENSSL_KEY: "original-openssl-key-0123456789ab",
	SESSION_TOKEN: "jwt-signed-with-the-key",
	ADMIN_PASSWORD: "generated-admin-pass",
};

function save(changes: {
	set?: Record<string, string>;
	remove?: string[];
	reset?: string[];
}) {
	return updateAppEnv(editor, APP, {
		set: changes.set ?? {},
		remove: changes.remove ?? [],
		reset: changes.reset ?? [],
		version: envVersion(state.row as never),
	});
}

beforeEach(() => {
	vi.stubEnv("ENCRYPTION_KEY", KEY);
	state.row = {
		id: APP,
		teamId: TEAM,
		templateId: "demo",
		envEncrypted: encrypt(JSON.stringify(deployed)),
		envPendingAt: null,
		envDeployedEncrypted: null,
		inputs: { overrides: {} },
		needsRedeploy: false,
	};
	state.updates = [];
});

describe("env overrides at rest (BUG-018)", () => {
	it("never stores a secret override in plain text", async () => {
		await save({ set: { SMTP_PASSWORD, ROUTER_API_TOKEN: "custom-t0ken-9" } });
		const stored = state.updates[0].inputs;
		expect(JSON.stringify(stored)).not.toContain(SMTP_PASSWORD);
		expect(JSON.stringify(stored)).not.toContain("custom-t0ken-9");
		expect(stored).not.toHaveProperty("overrides");
		// Read back decrypted by every consumer (render, previews, backups).
		expect(appInputs(state.row as never).overrides).toEqual({
			SMTP_PASSWORD,
			ROUTER_API_TOKEN: "custom-t0ken-9",
		});
		const view = await getAppEnv(editor, APP);
		expect(view.text).not.toContain(SMTP_PASSWORD);
		expect(
			view.variables.find((variable) => variable.name === "SMTP_PASSWORD"),
		).toMatchObject({ secret: true, overridden: true });
	});

	it("keeps other inputs readable and drops the field when nothing is overridden", async () => {
		state.row.inputs = { overrides: {}, initialised: ["SMTP_HOST"] };
		await save({ set: { SMTP_PASSWORD } });
		expect(state.row.inputs).toMatchObject({ initialised: ["SMTP_HOST"] });
		await save({ reset: ["SMTP_PASSWORD"] });
		expect(state.row.inputs).toEqual({ initialised: ["SMTP_HOST"] });
		expect(appInputs(state.row as never).overrides).toEqual({});
	});

	it("carries an encrypted override over the next edit", async () => {
		await save({ set: { SMTP_PASSWORD } });
		await save({ set: { SMTP_HOST: "mail.test" } });
		expect(appInputs(state.row as never).overrides).toEqual({
			SMTP_PASSWORD,
			SMTP_HOST: "mail.test",
		});
		expect(JSON.stringify(state.row.inputs)).not.toContain(SMTP_PASSWORD);
	});

	it("still reads rows stored with plain overrides", () => {
		const legacy = { inputs: { overrides: { SMTP_PASSWORD } } };
		expect(appInputs(legacy as never).overrides).toEqual({ SMTP_PASSWORD });
		// ...and rewrites them encrypted.
		const rewritten = storedAppInputs(appInputs(legacy as never));
		expect(JSON.stringify(rewritten)).not.toContain(SMTP_PASSWORD);
	});

	it("is re-encrypted by a key rotation", async () => {
		const inputs = storedAppInputs({ overrides: { SMTP_PASSWORD } });
		expect(
			encryptedColumns.some(
				(entry) =>
					entry.table === apps &&
					entry.jsonField?.column === apps.inputs &&
					entry.jsonField.key === "overridesEncrypted",
			),
		).toBe(true);
		const written: Record<string, unknown>[] = [];
		const tx = {
			select: (selected: Record<string, unknown>) => ({
				from: (table: unknown) => ({
					for: async () =>
						table === apps && "json" in selected
							? [{ id: APP, json: inputs }]
							: [],
				}),
			}),
			update: () => ({
				set: (patch: Record<string, unknown>) => ({
					where: async () => {
						written.push(patch);
					},
				}),
			}),
		};
		const fakeDb = { transaction: (run: (t: unknown) => unknown) => run(tx) };
		const count = await reencryptAll(fakeDb as never, {
			oldSecret: KEY,
			newSecret: NEW_KEY,
		});
		expect(count).toBe(1);
		vi.stubEnv("ENCRYPTION_KEY", NEW_KEY);
		expect(appInputs(written[0] as never).overrides).toEqual({
			SMTP_PASSWORD,
		});
	});
});
