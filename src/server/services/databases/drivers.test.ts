import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { DATABASE_ENGINE_IDS, databaseEngines } = await import(
	"#/config/database-engines.ts"
);
const { serverEngines } = await import("./engines");

/**
 * The engine driver contract: feature code calls these and never branches
 * on an engine id, so every registered engine must implement them.
 */

const nonce = "0123456789abcdef0123456789abcdef";
const target = {
	container: "database-0123abcd-db",
	values: {
		DB_USER: "app",
		DB_NAME: "app",
		DB_PASSWORD: "pw",
		CONSOLE_PASSWORD: "console-pw",
	},
	nonce,
	limits: { timeoutMs: 15_000, maxBytes: 1 << 20, maxErrorBytes: 1 << 16 },
};
const request = (text: string, readOnly = true) => ({
	text,
	database: null,
	readOnly,
	maxBytes: 64 * 1024,
	scanMaxCount: 1000,
});

describe("engine drivers", () => {
	it.each(
		DATABASE_ENGINE_IDS,
	)("%s implements the whole driver and matches its client registry entry", (id) => {
		const engine = serverEngines[id];
		const definition = databaseEngines[id];
		const probe = engine.size.probe(target);
		expect(probe.command).toContain(target.container);
		expect(typeof engine.size.parse).toBe("function");
		expect(typeof engine.console.prepare).toBe("function");
		expect(typeof engine.formatError).toBe("function");
		// The users tab exists exactly for engines with an admin driver.
		expect(!!engine.admin).toBe(definition.manageUsers);
		if (definition.databaseOwner) expect(engine.admin).toBeDefined();
		const endpoint = { host: "db.example.org", port: definition.port };
		const login = engine.login(target.values);
		expect(
			engine.connectionUrl(endpoint, { ...login, password: null }),
		).toMatch(/^[a-z]+:\/\/[^:]*@db\.example\.org:\d+/);
		expect(engine.clientCommand(endpoint, login)).not.toContain(
			target.values.DB_PASSWORD,
		);
	});

	it("parses each engine's size probe output", () => {
		expect(serverEngines.postgres.size.parse("123456\n")).toBe(123456);
		expect(serverEngines.mysql.size.parse("42\n")).toBe(42);
		expect(
			serverEngines.valkey.size.parse("# Memory\nused_memory:2048\n"),
		).toBe(2048);
		expect(
			serverEngines.mongodb.size.parse('{ "totalSize": 4096, "ok": 1 }'),
		).toBe(4096);
		expect(serverEngines.postgres.size.parse("garbage")).toBeNull();
	});

	it("sets up the console login where the engine has one", () => {
		expect(serverEngines.valkey.consoleLogin(target)).toBeNull();
		const mongo = serverEngines.mongodb.consoleLogin(target);
		expect(mongo?.verify?.("ok")).toBe(true);
		expect(mongo?.verify?.("MongoServerError")).toBe(false);
		expect(serverEngines.mariadb.consoleLogin(target)?.input).toContain(
			"console-pw",
		);
	});

	it("turns console output into results", () => {
		expect(serverEngines.postgres.console.outcome("", nonce, 10)).toEqual({
			kind: "none",
			text: "",
		});
		expect(
			serverEngines.postgres.console.outcome("a,b\n1,2\n", nonce, 10),
		).toMatchObject({ kind: "grid", columns: ["a", "b"], rows: [["1", "2"]] });
		expect(
			serverEngines.valkey.console.outcome("(error) ERR unknown", nonce, 10),
		).toEqual({ kind: "error", error: "(error) ERR unknown" });
		expect(serverEngines.valkey.console.outcome("OK\n", nonce, 10)).toEqual({
			kind: "text",
			text: "OK",
		});
		expect(
			serverEngines.mongodb.console.outcome(
				'{ "ok": 0, "errmsg": "no such cmd" }',
				nonce,
				10,
			),
		).toEqual({ kind: "error", error: "no such cmd" });
	});

	it("checks console input for the mode before building the run", () => {
		expect(() =>
			serverEngines.valkey.console.prepare(target, request("SET a b")),
		).toThrow();
		const plan = serverEngines.valkey.console.prepare(
			target,
			request("GET secret-key"),
		);
		expect(plan.audited).toEqual(["GET secret-key"]);
		const sql = serverEngines.postgres.console.prepare(
			target,
			request("SELECT 'hunter2' AS a", false),
		);
		// Literals never reach the audit log.
		expect(sql.audited.join()).not.toContain("hunter2");
		expect(sql.input).toBe("SELECT 'hunter2' AS a");
		// MariaDB alone refreshes the read-only grants before a run.
		expect(serverEngines.mariadb.console.beforeReadOnly).toBeDefined();
		expect(serverEngines.mysql.console.beforeReadOnly).toBeUndefined();
	});

	it("protects the engine's and the app's own names", () => {
		const main = { user: "app", database: "app" };
		const postgres = serverEngines.postgres.admin;
		const mysql = serverEngines.mysql.admin;
		expect(postgres?.isProtected("database", "template0", main)).toBe(true);
		expect(postgres?.isProtected("database", "shop", main)).toBe(false);
		expect(postgres?.isProtected("user", "app", main)).toBe(true);
		expect(mysql?.isProtected("user", "mysql.session", main)).toBe(true);
		expect(mysql?.isProtected("user", "mysql.anything", main)).toBe(true);
		expect(mysql?.isProtected("user", "reporting", main)).toBe(false);
	});

	it("builds admin steps per engine (Postgres grants inside the database too)", () => {
		expect(serverEngines.postgres.admin?.grant("shop", "reporting")).toEqual([
			{ sql: expect.stringContaining("ON DATABASE") },
			{ sql: expect.stringContaining("SCHEMA public"), database: "shop" },
		]);
		expect(serverEngines.mysql.admin?.grant("shop", "reporting")).toEqual([
			{ sql: expect.stringContaining("'reporting'@'%'") },
		]);
		expect(
			serverEngines.postgres.admin?.createDatabase("shop", "reporting")[0].sql,
		).toContain("OWNER");
	});
});
