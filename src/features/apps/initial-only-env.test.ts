import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Permission } from "#/config/permissions.ts";

/**
 * OneDev #11, BUG-014: PocketBase creates its superuser on the first start
 * only, so a later PB_ADMIN_PASSWORD did nothing while the panel showed it
 * as the login. Template `initial_only` variables are frozen once the app
 * has been deployed: the env editor refuses changes and shows them
 * read-only, the credentials card labels them as the initial value.
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
		id: "pocketbase",
		source: { type: "github" },
		variables: {
			PB_ADMIN_EMAIL: {
				value: "admin@${domain}",
				label: "Admin email",
				editable: true,
				credential: true,
				initial_only: true,
				type: "string",
			},
			PB_ADMIN_PASSWORD: {
				value: "${password:24}",
				label: "Admin password",
				editable: true,
				credential: true,
				secret: true,
				initial_only: true,
				type: "string",
			},
			PB_SMTP_HOST: { value: "", editable: true, type: "string" },
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
const { appInputs, envVersion, getAppEnv, listCredentials, updateAppEnv } =
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

function save(set: Record<string, string>, reset: string[] = []) {
	return updateAppEnv(editor, APP, {
		set,
		remove: [],
		reset,
		version: envVersion(state.row as never),
	});
}

beforeEach(() => {
	state.row = {
		id: APP,
		teamId: TEAM,
		templateId: "pocketbase",
		envEncrypted: JSON.stringify({
			PB_ADMIN_EMAIL: "admin@pb.test",
			PB_ADMIN_PASSWORD: "first-password",
			PB_SMTP_HOST: "",
		}),
		envPendingAt: null,
		envDeployedEncrypted: null,
		composeDeployed: "services: {}",
		inputs: { overrides: {} },
		needsRedeploy: false,
	};
	state.updates = [];
});

describe("initial_only variables of a deployed app", () => {
	it("env editor shows them read-only, as applied", async () => {
		const env = await getAppEnv(editor, APP);
		const password = env.variables.find(
			(item) => item.name === "PB_ADMIN_PASSWORD",
		);
		expect(password).toMatchObject({ locked: true, initialOnly: "applied" });
		expect(
			env.variables.find((item) => item.name === "PB_SMTP_HOST"),
		).toMatchObject({ locked: false, initialOnly: undefined });
	});

	it("refuses to change one (the app would ignore it)", async () => {
		await expect(
			save({ PB_ADMIN_PASSWORD: "second-password" }),
		).rejects.toMatchObject({
			code: "ENV_INITIAL_ONLY",
			params: { name: "PB_ADMIN_PASSWORD" },
		});
		expect(state.updates).toEqual([]);
	});

	it("still saves other variables", async () => {
		await save({ PB_SMTP_HOST: "smtp.test" });
		expect(state.updates[0]).toMatchObject({ needsRedeploy: true });
		expect(appInputs(state.updates[0] as never).overrides).toMatchObject({
			PB_SMTP_HOST: "smtp.test",
		});
	});

	it("labels the credentials as initial values", async () => {
		const credentials = await listCredentials(state.row as never);
		expect(credentials).toEqual([
			expect.objectContaining({
				name: "PB_ADMIN_EMAIL",
				value: "admin@pb.test",
				initial: true,
			}),
			expect.objectContaining({ name: "PB_ADMIN_PASSWORD", initial: true }),
		]);
	});
});

describe("initial_only variables before the first deploy", () => {
	beforeEach(() => {
		state.row.composeDeployed = null;
	});

	it("are editable and say they are read on the first start", async () => {
		const env = await getAppEnv(editor, APP);
		expect(
			env.variables.find((item) => item.name === "PB_ADMIN_PASSWORD"),
		).toMatchObject({ locked: false, initialOnly: "first_start" });
		await save({ PB_ADMIN_PASSWORD: "second-password" });
		expect(appInputs(state.updates[0] as never).overrides).toMatchObject({
			PB_ADMIN_PASSWORD: "second-password",
		});
		const credentials = await listCredentials(state.row as never);
		expect(credentials.every((item) => !item.initial)).toBe(true);
	});
});

describe("the initialised marker (set when a deploy reaches compose up)", () => {
	beforeEach(() => {
		// The first deploy failed after `compose up`: never succeeded.
		state.row.composeDeployed = null;
		state.row.inputs = {
			overrides: {},
			initialised: ["PB_ADMIN_EMAIL", "PB_ADMIN_PASSWORD"],
		};
	});

	it("freezes the values even though no deploy succeeded", async () => {
		await expect(
			save({ PB_ADMIN_PASSWORD: "second-password" }),
		).rejects.toMatchObject({ code: "ENV_INITIAL_ONLY" });
		const env = await getAppEnv(editor, APP);
		expect(
			env.variables.find((item) => item.name === "PB_ADMIN_PASSWORD"),
		).toMatchObject({ locked: true, initialOnly: "applied" });
	});

	it("leaves one the app was not initialised with (added later) editable", async () => {
		state.row.composeDeployed = "services: {}";
		state.row.inputs = { overrides: {}, initialised: ["PB_ADMIN_EMAIL"] };
		const env = await getAppEnv(editor, APP);
		expect(
			env.variables.find((item) => item.name === "PB_ADMIN_PASSWORD"),
		).toMatchObject({ locked: false, initialOnly: "not_applied" });
		const credentials = await listCredentials(state.row as never);
		expect(credentials.map((item) => [item.name, item.initial])).toEqual([
			["PB_ADMIN_EMAIL", true],
			["PB_ADMIN_PASSWORD", false],
		]);
	});
});
