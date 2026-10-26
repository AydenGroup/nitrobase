import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Permission } from "#/config/permissions.ts";

/**
 * A database is an app row: app endpoints must not let `app.*` permissions
 * act on it without the matching `database.*` ones (R3 review B1). The
 * real server functions run against a stubbed database row; the first
 * query returns the row, anything after the access check stops.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const TEAM = "00000000-0000-4000-8000-0000000000aa";
const APP = "00000000-0000-4000-8000-0000000000db";
let row: Record<string, unknown>;

class Stop extends Error {}

/** `db.select()…` resolves the row; any other use stops the function. */
function chain(): unknown {
	const target = () => chain();
	return new Proxy(target, {
		get(_, key) {
			if (key === "then") {
				return (resolve: (value: unknown) => void) => resolve([row]);
			}
			if (key === "limit") return async () => [row];
			return () => chain();
		},
	});
}
vi.mock("#/db/index.ts", () => ({
	db: new Proxy(
		{},
		{
			get(_, key) {
				if (key === "select") return () => chain();
				throw new Stop(`db.${String(key)}`);
			},
		},
	),
}));

const { withImplied } = await import("#/config/permissions.ts");
const apps = await import("./apps.server");
const jobs = await import("./app-jobs.server");
const move = await import("./move.server");
const tasks = await import("#/features/tasks/tasks.server.ts");
const backups = await import("#/features/backups/backups.server.ts");

function actor(granted: Permission[], gate: Permission) {
	return {
		userId: null,
		teamId: TEAM,
		role: null,
		permissions: new Set(withImplied(granted)),
		instanceAdmin: false,
		via: "token" as const,
		tokenId: "t1",
		gate,
	};
}

const APP_ONLY: Permission[] = [
	"app.view",
	"app.deploy",
	"app.delete",
	"app.move",
	"app.env.edit",
	"app.env.reveal",
	"app.terminal",
	"app.database",
	"app.tasks.manage",
	"app.source.manage",
	"app.resources.manage",
	"domain.manage",
	// Not app permissions: kept so a refusal can only come from the row.
	"backup.view",
];

/** Representative app endpoints: name, gate, call. */
const calls: [
	string,
	Permission,
	(a: ReturnType<typeof actor>) => Promise<unknown>,
][] = [
	["getAppEnv", "app.view", (a) => apps.getAppEnv(a, APP)],
	["revealAppEnv", "app.env.reveal", (a) => apps.revealAppEnv(a, APP)],
	[
		"updateAppEnv",
		"app.env.edit",
		(a) =>
			apps.updateAppEnv(a, APP, {
				set: {},
				remove: [],
				reset: [],
				version: "",
			}),
	],
	[
		"terminal upgrade",
		"app.terminal",
		(a) => apps.getAppRow(a, APP, "app.terminal"),
	],
	[
		"redeploy",
		"app.deploy",
		(a) => jobs.startAppAction(a, { appId: APP, action: "redeploy" }),
	],
	[
		"delete",
		"app.delete",
		(a) =>
			jobs.deleteApp(a, {
				appId: APP,
				confirmName: "database-00000000",
				wipeData: false,
				removeImages: false,
			}),
	],
	[
		"move",
		"app.move",
		(a) =>
			move.startMoveApp(a, {
				appId: APP,
				targetServerId: APP,
				destinationId: APP,
			}),
	],
	["list tasks", "app.view", (a) => tasks.listTasks(a, APP)],
	[
		"cancel job",
		"app.deploy",
		(a) => jobs.assertCanCancelJob(a, { appId: APP }),
	],
	[
		"create task",
		"app.tasks.manage",
		(a) =>
			tasks.createTask(a, {
				appId: APP,
				name: "x",
				cron: "0 3 * * *",
			} as never),
	],
];

async function outcome(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
		return "ok";
	} catch (error) {
		const code = (error as { code?: string }).code;
		return code === "FORBIDDEN" || code === "APP_NOT_FOUND" ? code : "passed";
	}
}

describe("database rows through app endpoints", () => {
	beforeEach(() => {
		row = {
			id: APP,
			teamId: TEAM,
			serverId: APP,
			templateId: "database",
			folder: "database-00000000",
			version: "postgres@18.6",
			status: "running",
			inputs: { overrides: {} },
			envEncrypted: null,
			composeDeployed: null,
		};
	});

	it.each(
		calls,
	)("%s is refused with app.* permissions only", async (_, gate, call) => {
		expect(await outcome(() => call(actor(APP_ONLY, gate)))).toBe("FORBIDDEN");
	});

	it.each(
		calls,
	)("%s passes the check with database.* permissions", async (_, gate, call) => {
		const granted: Permission[] = [
			...APP_ONLY,
			"database.manage",
			"database.write",
			"database.credentials.reveal",
			// The move also reads its destination.
			"backup.view",
		];
		expect(await outcome(() => call(actor(granted, gate)))).not.toBe(
			"FORBIDDEN",
		);
	});

	it("viewing needs database.view, revealing database.credentials.reveal", async () => {
		const viewer = actor(["database.view"], "app.view");
		expect(await outcome(() => apps.getAppRow(viewer, APP))).toBe("ok");
		const revealer = actor(["database.manage"], "app.env.reveal");
		expect(
			await outcome(() => apps.getAppRow(revealer, APP, "app.env.reveal")),
		).toBe("FORBIDDEN");
	});

	it("regular apps keep the app permissions", async () => {
		row.templateId = "pocketbase";
		expect(
			await outcome(() =>
				jobs.startAppAction(actor(APP_ONLY, "app.deploy"), {
					appId: APP,
					action: "redeploy",
				}),
			),
		).not.toBe("FORBIDDEN");
	});
});

describe("database backups need the database permissions too", () => {
	beforeEach(() => {
		row = {
			id: APP,
			teamId: TEAM,
			appId: APP,
			kind: "app",
			templateId: "database",
			status: "success",
		};
	});
	const base: Permission[] = [
		"backup.view",
		"backup.restore",
		"backup.download",
		"database.manage",
	];

	it("restore needs database.write", async () => {
		const call = (granted: Permission[]) =>
			outcome(() =>
				backups.getBackupRow(actor(granted, "backup.restore"), APP),
			);
		expect(await call(base)).toBe("FORBIDDEN");
		expect(await call([...base, "database.write"])).toBe("ok");
	});

	it("download needs database.credentials.reveal", async () => {
		const call = (granted: Permission[]) =>
			outcome(() =>
				backups.getBackupRow(actor(granted, "backup.download"), APP),
			);
		expect(await call(base)).toBe("FORBIDDEN");
		expect(await call([...base, "database.credentials.reveal"])).toBe("ok");
	});

	it("app backups keep the backup permissions", async () => {
		row.templateId = "pocketbase";
		expect(
			await outcome(() =>
				backups.getBackupRow(
					actor(["backup.view", "backup.restore"], "backup.restore"),
					APP,
				),
			),
		).toBe("ok");
	});

	it("restoring over a database row needs database.write as well", async () => {
		row = { ...row, templateId: "database", folder: "database-00000000" };
		const granted: Permission[] = [...base, "app.view"];
		expect(
			await outcome(() =>
				apps.getAppRow(actor(granted, "backup.restore"), APP),
			),
		).toBe("FORBIDDEN");
	});
});

describe("cancelling a server job", () => {
	it("needs server.manage", async () => {
		expect(
			await outcome(() =>
				jobs.assertCanCancelJob(actor(["app.deploy"], "app.deploy"), {
					appId: null,
				}),
			),
		).toBe("FORBIDDEN");
	});
});
