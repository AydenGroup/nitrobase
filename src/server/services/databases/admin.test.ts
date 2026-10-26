import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const admin = await import("./admin");

describe("users and databases SQL", () => {
	it("quotes postgres identifiers and literals", () => {
		expect(admin.pgCreateDatabaseSql("shop-db", "shop_user")).toBe(
			'CREATE DATABASE "shop-db" OWNER "shop_user"',
		);
		expect(admin.pgCreateUserSql("shop.user", "pa'ss")).toBe(
			`CREATE ROLE "shop.user" LOGIN PASSWORD E'pa''ss'`,
		);
		expect(admin.pgGrantSql("shop", "u")).toEqual({
			cluster: 'GRANT ALL PRIVILEGES ON DATABASE "shop" TO "u"',
			inDatabase: 'GRANT ALL ON SCHEMA public TO "u"',
		});
		expect(admin.pgDropDatabaseSql("shop")).toBe(
			'DROP DATABASE "shop" WITH (FORCE)',
		);
		expect(admin.pgDropUserSql("u")).toBe('DROP ROLE "u"');
	});

	it("quotes mysql identifiers with backticks", () => {
		expect(admin.mysqlCreateDatabaseSql("shop-db")).toBe(
			"CREATE DATABASE `shop-db`;",
		);
		expect(admin.mysqlCreateUserSql("u", "pw")).toBe(
			"CREATE USER 'u'@'%' IDENTIFIED BY 'pw';",
		);
		expect(admin.mysqlGrantSql("shop", "u", "%")).toBe(
			"GRANT ALL PRIVILEGES ON `shop`.* TO 'u'@'%';",
		);
		expect(admin.mysqlDropUserSql("u", "localhost")).toBe(
			"DROP USER 'u'@'localhost';",
		);
	});

	it("refuses names outside the managed patterns", () => {
		for (const name of [
			'a"b',
			"a`b",
			"a b",
			"x;DROP",
			"",
			"1abc",
			"a".repeat(65),
		]) {
			expect(() => admin.pgCreateDatabaseSql(name, null), name).toThrow();
			expect(() => admin.mysqlCreateDatabaseSql(name), name).toThrow();
		}
		expect(() => admin.mysqlGrantSql("shop", "u", "a'b")).toThrow();
		expect(() => admin.pgCreateUserSql("u", "a\0b")).toThrow();
	});

	it("protects engine, Nitrobase and main names", () => {
		const pg = admin.protectedNames("postgres", {
			user: "app",
			database: "app",
		});
		expect([...pg.databases]).toEqual(
			expect.arrayContaining(["postgres", "template0", "template1", "app"]),
		);
		expect([...pg.users]).toEqual(
			expect.arrayContaining(["nitrobase_console", "app"]),
		);
		const my = admin.protectedNames("mysql", { user: "app", database: "app" });
		expect([...my.databases]).toEqual(
			expect.arrayContaining([
				"mysql",
				"sys",
				"information_schema",
				"performance_schema",
				"app",
			]),
		);
		expect([...my.users]).toEqual(
			expect.arrayContaining(["root", "nitrobase_console", "app"]),
		);
	});

	it("admin commands read SQL on stdin (no argv), capped, passwords from the env", () => {
		const nonce = "0123456789abcdef0123456789abcdef";
		const limits = { timeoutMs: 60000, maxBytes: 100000, maxErrorBytes: 4096 };
		const pg = admin.pgAdminCommand({
			container: "database-0123abcd-db",
			superuser: "app",
			database: "shop",
			nonce,
			limits,
		});
		expect(pg).toContain("-f -");
		expect(pg).not.toContain("$sql");
		expect(pg).toContain("tail -c 4096");
		expect(pg).toContain("'app' 'shop'");
		expect(() =>
			admin.pgAdminCommand({
				container: "x",
				superuser: "app",
				database: "a=b",
				nonce,
				limits,
			}),
		).toThrow();
		const my = admin.mysqlAdminCommand({
			kind: "mysql",
			container: "database-0123abcd-db",
			rootPasswordEnv: "MYSQL_ROOT_PASSWORD",
			nonce,
			limits,
		});
		expect(my).toContain('MYSQL_PWD="$(printenv MYSQL_ROOT_PASSWORD)" mysql');
		expect(my).toContain("head -c 100000");
	});
});
