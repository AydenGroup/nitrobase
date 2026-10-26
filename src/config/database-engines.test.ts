import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const registry = await import("./database-engines");
const { serverEngines } = await import(
	"#/server/services/databases/engines.ts"
);
const { databaseStrategies } = await import(
	"#/server/services/backup/db-strategies.ts"
);

describe("database engine registry", () => {
	it("every engine is complete on both sides", () => {
		for (const id of registry.DATABASE_ENGINE_IDS) {
			const engine = registry.databaseEngines[id];
			expect(engine.versions.length, id).toBeGreaterThan(0);
			expect(
				engine.versions.map((v) => v.tag),
				id,
			).toContain(engine.defaultVersion);
			for (const version of engine.versions) {
				expect(version.tag.startsWith(`${version.major}.`), version.tag).toBe(
					true,
				);
			}
			expect(engine.port).toBeGreaterThan(1023);
			expect(engine.image).toMatch(/^[a-z0-9/-]+$/);
			expect(engine.linkEnv.url).toMatch(/^[A-Z_][A-Z0-9_]*$/);
			expect(engine.memoryMb).toBeGreaterThan(0);
			const server = serverEngines[id];
			expect(server, id).toBeTruthy();
			const backup = server.backup({ DB_USER: "app", DB_NAME: "app" });
			expect(databaseStrategies[backup.type], id).toBeTruthy();
			expect(server.variables.DB_PASSWORD?.secret, id).toBe(true);
		}
	});

	it("versions round-trip through the app version", () => {
		expect(registry.databaseVersionRef("postgres", "18.6")).toBe(
			"postgres@18.6",
		);
		expect(registry.parseDatabaseVersion("postgres@18.6")).toEqual({
			engine: "postgres",
			tag: "18.6",
		});
		expect(registry.parseDatabaseVersion("nope@1")).toBeNull();
		expect(registry.parseDatabaseVersion("postgres@latest")).toBeNull();
		expect(registry.parseDatabaseVersion("postgres@1;rm")).toBeNull();
	});

	it("upgrades in place only forward, within the major line for patch engines", () => {
		expect(registry.canUpgradeInPlace("postgres", "17.11", "18.6")).toBe(false);
		expect(registry.canUpgradeInPlace("postgres", "18.4", "18.6")).toBe(true);
		expect(registry.canUpgradeInPlace("postgres", "18.6", "18.6")).toBe(false);
		expect(registry.canUpgradeInPlace("mysql", "8.4.10", "8.4.11")).toBe(true);
		expect(registry.canUpgradeInPlace("mysql", "8.4.11", "9.7.2")).toBe(false);
		expect(registry.canUpgradeInPlace("mariadb", "10.11.19", "11.8.9")).toBe(
			true,
		);
		expect(registry.canUpgradeInPlace("mariadb", "11.8.9", "10.11.19")).toBe(
			false,
		);
		expect(registry.canUpgradeInPlace("valkey", "8.1.10", "9.1.2")).toBe(true);
		expect(registry.canUpgradeInPlace("postgres", "18.4", "18.99")).toBe(false);
		expect(
			registry.upgradeTargets("valkey", "8.1.10").map((v) => v.tag),
		).toEqual(["9.1.2", "9.0.6"]);
	});
});
