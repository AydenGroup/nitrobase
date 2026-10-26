import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { assertCanAccess, memberPermissions, systemActor } = await import(
	"./access"
);
const { permissionIds, permissions, roleIds, rolePermissions, roles } =
	await import("#/config/permissions.ts");
const { AppError } = await import("#/utils/error.ts");

const actor = (
	role: "owner" | "admin" | "developer" | "viewer",
	admin = false,
) => ({
	userId: "u1",
	teamId: "t1",
	role,
	permissions: memberPermissions(role, admin),
	instanceAdmin: admin,
	via: "session" as const,
});

const code = (fn: () => unknown) => {
	try {
		fn();
		return "ok";
	} catch (error) {
		return error instanceof AppError ? error.code : String(error);
	}
};

describe("role registry", () => {
	it("ranks roles and only grants registered team permissions", () => {
		const ranks = roleIds.map((id) => roles[id].rank);
		expect(new Set(ranks).size).toBe(ranks.length);
		for (const role of roleIds) {
			for (const permission of rolePermissions(role)) {
				expect(permissionIds).toContain(permission);
				expect(permissions[permission].scope).toBe("team");
			}
		}
	});

	it("gives each role what its description promises", () => {
		const has = (role: Parameters<typeof actor>[0], id: string) =>
			actor(role).permissions.has(id as never);
		expect(has("owner", "team.manage")).toBe(true);
		expect(has("admin", "team.manage")).toBe(false);
		expect(has("admin", "members.manage")).toBe(true);
		expect(has("developer", "app.deploy")).toBe(true);
		expect(has("developer", "server.manage")).toBe(false);
		expect(has("developer", "members.manage")).toBe(false);
		expect(has("viewer", "app.view")).toBe(true);
		expect(has("viewer", "app.env.reveal")).toBe(false);
		expect(has("viewer", "app.deploy")).toBe(false);
		// Instance permissions never come from a team role.
		expect(has("owner", "instance.manage")).toBe(false);
		expect(actor("viewer", true).permissions.has("instance.manage")).toBe(true);
	});
});

describe("assertCanAccess", () => {
	it("hides other teams' resources as not found", () => {
		const owner = actor("owner");
		expect(
			code(() =>
				assertCanAccess(owner, { teamId: "t2" }, "app.view", "APP_NOT_FOUND"),
			),
		).toBe("APP_NOT_FOUND");
		expect(
			code(() => assertCanAccess(owner, null, "app.view", "APP_NOT_FOUND")),
		).toBe("APP_NOT_FOUND");
		expect(
			code(() =>
				assertCanAccess(owner, { teamId: "t1" }, "app.view", "APP_NOT_FOUND"),
			),
		).toBe("ok");
	});

	it("refuses a team resource when the role lacks the permission", () => {
		const viewer = actor("viewer");
		expect(
			code(() =>
				assertCanAccess(
					viewer,
					{ teamId: "t1" },
					"app.deploy",
					"APP_NOT_FOUND",
				),
			),
		).toBe("FORBIDDEN");
		expect(code(() => assertCanAccess(viewer, "server.manage"))).toBe(
			"FORBIDDEN",
		);
		expect(code(() => assertCanAccess(viewer, "server.view"))).toBe("ok");
	});

	it("lets scheduled work act with team permissions, not instance ones", () => {
		const system = systemActor("t1", "u1");
		expect(system.permissions.has("backup.create")).toBe(true);
		expect(system.permissions.has("instance.manage")).toBe(false);
		expect(
			systemActor("t1", null, { instance: true }).permissions.has(
				"instance.manage",
			),
		).toBe(true);
	});
});
