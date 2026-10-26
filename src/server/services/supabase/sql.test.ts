import { describe, expect, it } from "vitest";
import {
	assertOwnerSql,
	dropFunctionSql,
	functionDefinitionQuery,
	listFunctionsQuery,
	listSchemasQuery,
	newFunctionSql,
	psqlCommand,
	quoteIdent,
	quoteLiteral,
} from "./sql";

describe("quoteIdent", () => {
	it.each([
		["users", '"users"'],
		["My Table", '"My Table"'],
		['a"b', '"a""b"'],
		['"; DROP TABLE x; --', '"""; DROP TABLE x; --"'],
	])("%j -> %s", (input, expected) => {
		expect(quoteIdent(input)).toBe(expected);
	});

	it("rejects empty and NUL", () => {
		expect(() => quoteIdent("")).toThrow();
		expect(() => quoteIdent("a\0b")).toThrow();
	});
});

describe("quoteLiteral", () => {
	it.each([
		["public", "E'public'"],
		["it's", "E'it''s'"],
		["a\\'b", "E'a\\\\''b'"],
		["'; DROP SCHEMA public; --", "E'''; DROP SCHEMA public; --'"],
	])("%j -> %s", (input, expected) => {
		expect(quoteLiteral(input)).toBe(expected);
	});
});

describe("queries", () => {
	it("scopes by a quoted schema literal and validated oid", () => {
		expect(listFunctionsQuery("public")).toContain(
			"WHERE n.nspname = E'public'",
		);
		expect(functionDefinitionQuery("app", 16384)).toBe(
			"SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = 16384 AND n.nspname = E'app' AND p.prokind IN ('f', 'p')",
		);
		expect(listSchemasQuery()).toContain(
			"WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'",
		);
	});

	it("rejects unsafe schema names and oids", () => {
		expect(() => listFunctionsQuery("a'; --")).toThrow();
		expect(() => listFunctionsQuery("$nitrobase_drop$")).toThrow();
		expect(() => functionDefinitionQuery("public", 1.5)).toThrow();
		expect(() => dropFunctionSql("public", -1)).toThrow();
	});

	it("drops by oid with server-side format('%I')", () => {
		const sql = dropFunctionSql("public", 42);
		expect(sql).toContain("format('DROP %s %I.%I(%s)'");
		expect(sql).toContain("WHERE p.oid = 42");
		expect(sql).toContain("AND n.nspname = E'public'");
		expect(sql.startsWith("DO $nitrobase_drop$")).toBe(true);
	});

	it("quotes the schema of the starter function", () => {
		expect(newFunctionSql("My_schema").split("\n")[0]).toBe(
			`CREATE OR REPLACE FUNCTION "My_schema".hello(name text DEFAULT 'world')`,
		);
	});
});

describe("psqlCommand", () => {
	const target = {
		container: "supabase-0123abcd-db",
		user: "supabase_admin",
		database: "postgres",
		timeoutMs: 30_000,
	};

	it("reads SQL from stdin and runs it with -c (no meta-commands)", () => {
		expect(psqlCommand(target, true)).toBe(
			`docker exec -i -e 'PGOPTIONS=-c statement_timeout=30000' 'supabase-0123abcd-db' sh -c 'sql=$(cat); exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$1" -d "$2" -c "$sql"' sh 'supabase_admin' 'postgres'`,
		);
		expect(psqlCommand(target, false)).toContain("exec psql -X -q -v");
	});

	it("validates every interpolated part", () => {
		expect(() => psqlCommand({ ...target, container: "x;id" }, true)).toThrow();
		expect(() => psqlCommand({ ...target, user: "x' y" }, true)).toThrow();
	});
});

describe("assertOwnerSql", () => {
	it("refuses meta-commands, NUL and oversized SQL", () => {
		expect(() => assertOwnerSql("  \\! id", 1000)).toThrow(/meta-commands/);
		expect(() => assertOwnerSql("   ", 1000)).toThrow();
		expect(() => assertOwnerSql("select 1\0", 1000)).toThrow();
		expect(() => assertOwnerSql("select 1", 3)).toThrow();
		expect(assertOwnerSql("select '\\x'", 1000)).toBe("select '\\x'");
	});
});
