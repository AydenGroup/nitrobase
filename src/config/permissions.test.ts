import { describe, expect, it, vi } from "vitest";
import type { Permission } from "./permissions";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const {
	impliedBy,
	permissionIds,
	permissions,
	presetPermissions,
	rolePermissions,
	roleIds,
	tokenPresets,
	withImplied,
	databaseRowRequirements,
	databaseRowExtraPermissions,
} = await import("./permissions");

describe("permission registry", () => {
	it("implies only known team permissions", () => {
		for (const id of permissionIds) {
			for (const implied of permissions[id].implies ?? []) {
				expect(permissionIds).toContain(implied);
			}
		}
	});

	it("deploying implies seeing apps and servers", () => {
		expect(impliedBy("app.deploy").sort()).toEqual(["app.view", "server.view"]);
		expect(withImplied(["app.deploy"]).sort()).toEqual(
			["app.deploy", "app.view", "server.view"].sort(),
		);
	});

	it("every role is closed under implication", () => {
		for (const role of roleIds) {
			const granted = new Set<Permission>(rolePermissions(role));
			for (const id of granted) {
				for (const implied of impliedBy(id))
					expect(granted.has(implied)).toBe(true);
			}
		}
	});

	it("token presets resolve to their implied permissions", () => {
		const deployer = tokenPresets.find((preset) => preset.id === "deployer");
		expect(deployer && presetPermissions(deployer)).toContain("app.view");
		for (const preset of tokenPresets) {
			expect(presetPermissions(preset).length).toBeGreaterThan(0);
		}
	});
});

describe("database row mapping", () => {
	it("maps app permissions and adds the backup extras", () => {
		expect(databaseRowRequirements("app.deploy")).toEqual(["database.manage"]);
		expect(databaseRowRequirements("app.env.reveal")).toEqual([
			"database.credentials.reveal",
		]);
		expect(databaseRowRequirements("backup.restore")).toEqual([
			"backup.restore",
			"database.write",
		]);
		expect(databaseRowRequirements("backup.download")).toEqual([
			"backup.download",
			"database.credentials.reveal",
		]);
		expect(databaseRowRequirements("backup.view")).toEqual(["backup.view"]);
	});

	it("extras are known permissions", () => {
		for (const [id, extra] of Object.entries(databaseRowExtraPermissions)) {
			expect(permissionIds).toContain(id);
			for (const item of extra) expect(permissionIds).toContain(item);
		}
	});
});
