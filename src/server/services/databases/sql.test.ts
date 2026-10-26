import { describe, expect, it } from "vitest";
import {
	ConsoleRefusal,
	checkConsoleSql,
	maskSqlLiterals,
	mysqlIdent,
	mysqlLiteral,
	pgIdent,
	pgLiteral,
	scanSql,
} from "./sql";

const ro = { readOnly: true, maxBytes: 65536 };
const rw = { readOnly: false, maxBytes: 65536 };

describe("scanSql", () => {
	it("splits statements outside strings, identifiers, comments and dollar quotes", () => {
		const scanned = scanSql(
			[
				"SELECT 'a;b', \"c;d\" FROM t; -- x; y",
				"/* outer /* nested; */ still; */ SELECT $$ ; $$, $tag$ ; $tag$;",
				"SELECT E'it\\'s;'",
			].join("\n"),
			"postgres",
		);
		expect(scanned.statements.map((s) => s.words[0])).toEqual([
			"SELECT",
			"SELECT",
			"SELECT",
		]);
		expect(scanned.backslash).toBe(false);
	});

	it("detects backslash commands outside strings", () => {
		expect(scanSql("SELECT 1 \\g", "postgres").backslash).toBe(true);
		expect(scanSql("SELECT '\\g'", "postgres").backslash).toBe(false);
		expect(scanSql("SELECT 1; \\! ls", "mysql").backslash).toBe(true);
		expect(scanSql("SELECT 'a\\'b'", "mysql").backslash).toBe(false);
	});

	it("knows MySQL comments and executable comments", () => {
		const scanned = scanSql("# c;\nSELECT 1 -- c;\n; /*! DROP */", "mysql");
		expect(scanned.statements.map((s) => s.words[0])).toEqual([
			"SELECT",
			undefined,
		]);
		expect(scanned.executableComment).toBe(true);
		// "--" without a space is not a MySQL comment.
		expect(scanSql("SELECT 1--1", "mysql").statements).toHaveLength(1);
	});

	it("refuses unterminated quotes and comments", () => {
		expect(() => scanSql("SELECT 'x", "postgres")).toThrow(/Unterminated/);
		expect(() => scanSql("SELECT $a$ x", "postgres")).toThrow(/Unterminated/);
		expect(() => scanSql("/* x", "mysql")).toThrow(/Unterminated/);
	});
});

describe("read-only enforcement (statement rules)", () => {
	it("postgres: refuses transaction control and read-only setting changes", () => {
		for (const sql of [
			"COMMIT; INSERT INTO t VALUES (1)",
			"select 1; end",
			"ROLLBACK",
			"begin",
			"START TRANSACTION",
			"SAVEPOINT a",
			"PREPARE TRANSACTION 'x'",
			"SET TRANSACTION READ WRITE",
			"SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
			"set default_transaction_read_only = off",
			"SET LOCAL transaction_read_only = off",
			"RESET default_transaction_read_only",
			"SET ROLE postgres",
			"SET SESSION AUTHORIZATION postgres",
		]) {
			expect(() => checkConsoleSql(sql, "postgres", ro), sql).toThrow();
		}
		// Writes are left to the server (read-only role + transaction).
		expect(
			checkConsoleSql(
				"SELECT 1; WITH x AS (SELECT 2) SELECT * FROM x",
				"postgres",
				ro,
			).statements,
		).toHaveLength(2);
		expect(checkConsoleSql("COMMIT", "postgres", rw).statements).toHaveLength(
			1,
		);
	});

	it("postgres: no meta-commands in any mode", () => {
		expect(() => checkConsoleSql("\\! id", "postgres", rw)).toThrow(
			/backslash/,
		);
		expect(() => checkConsoleSql("SELECT 1 \\gexec", "postgres", rw)).toThrow();
	});

	it("mysql: only reading statements in read-only mode", () => {
		for (const sql of [
			"INSERT INTO t VALUES (1)",
			"DROP TABLE t",
			"CREATE TABLE t (a int)",
			"SET autocommit = 1",
			"COMMIT",
			"SELECT * FROM t INTO OUTFILE '/tmp/x'",
			"SELECT 1 INTO DUMPFILE '/tmp/x'",
			"SELECT 1 /*! , (DELETE FROM t) */",
		]) {
			expect(() => checkConsoleSql(sql, "mysql", ro), sql).toThrow();
		}
		expect(
			checkConsoleSql(
				"SHOW TABLES; DESCRIBE t; EXPLAIN SELECT 1; SELECT 1",
				"mysql",
				ro,
			).statements,
		).toHaveLength(4);
		expect(
			checkConsoleSql("INSERT INTO t VALUES (1)", "mysql", rw).statements,
		).toHaveLength(1);
	});

	it("mysql: client commands are refused in every mode", () => {
		for (const sql of [
			"system ls",
			"source /etc/passwd",
			"delimiter //",
			"SELECT 1;\nSYSTEM id",
			"pager cat",
		]) {
			expect(() => checkConsoleSql(sql, "mysql", rw), sql).toThrow();
		}
	});

	it("limits size and refuses empty input and NUL", () => {
		expect(() => checkConsoleSql(" ; ", "postgres", ro)).toThrow(/empty/);
		expect(() => checkConsoleSql("SELECT 1\0", "postgres", ro)).toThrow(/NUL/);
		expect(() =>
			checkConsoleSql(`SELECT '${"x".repeat(100)}'`, "postgres", {
				readOnly: true,
				maxBytes: 50,
			}),
		).toThrow(/exceeds/);
	});
});

describe("identifier and literal quoting", () => {
	it.each([
		["app", '"app"'],
		["My DB", '"My DB"'],
		['a"b', '"a""b"'],
		['x"; DROP DATABASE postgres; --', '"x""; DROP DATABASE postgres; --"'],
	])("pgIdent(%j) = %s", (input, expected) => {
		expect(pgIdent(input)).toBe(expected);
	});

	it.each([
		["app", "`app`"],
		["a`b", "`a``b`"],
		["x`; DROP DATABASE mysql; --", "`x``; DROP DATABASE mysql; --`"],
	])("mysqlIdent(%j) = %s", (input, expected) => {
		expect(mysqlIdent(input)).toBe(expected);
	});

	it("quotes literals safely", () => {
		expect(pgLiteral("it's")).toBe("E'it''s'");
		expect(pgLiteral("a\\'b")).toBe("E'a\\\\''b'");
		expect(mysqlLiteral("it's")).toBe("'it''s'");
		// Backslash meaning depends on NO_BACKSLASH_ESCAPES: refused.
		expect(() => mysqlLiteral("a\\")).toThrow();
		expect(() => pgIdent("")).toThrow();
		expect(() => mysqlIdent("a\0")).toThrow();
	});
});

describe("audit masking", () => {
	it("hides every literal, dollar quote and MySQL double-quoted string", () => {
		expect(
			maskSqlLiterals(`CREATE USER 'u'@'%' IDENTIFIED BY "s3cret"`, "mysql"),
		).toBe("CREATE USER '…'@'…' IDENTIFIED BY '…'");
		expect(
			maskSqlLiterals("ALTER ROLE u PASSWORD $$s3cret$$", "postgres"),
		).toBe("ALTER ROLE u PASSWORD '…'");
		expect(
			maskSqlLiterals("ALTER ROLE u PASSWORD $p$s3cret$p$", "postgres"),
		).toBe("ALTER ROLE u PASSWORD '…'");
		expect(
			maskSqlLiterals(`CREATE ROLE "Admin" PASSWORD E'it\\'s'`, "postgres"),
		).toBe(`CREATE ROLE "Admin" PASSWORD E'…'`);
		// Unreadable text: masked from the first quote on.
		expect(maskSqlLiterals("SELECT 'unterminated s3cret", "postgres")).toBe(
			"SELECT '…'",
		);
	});
});

describe("refusal codes", () => {
	const code = (fn: () => unknown) => {
		try {
			fn();
		} catch (error) {
			return error instanceof ConsoleRefusal ? error.code : "other";
		}
		return "none";
	};
	it("names the rule that refused", () => {
		const ro = { readOnly: true, maxBytes: 65536 };
		expect(code(() => checkConsoleSql("COMMIT", "postgres", ro))).toBe(
			"DATABASE_QUERY_READ_ONLY",
		);
		expect(code(() => checkConsoleSql("\\! id", "postgres", ro))).toBe(
			"DATABASE_QUERY_BACKSLASH",
		);
		expect(code(() => checkConsoleSql("system id", "mysql", ro))).toBe(
			"DATABASE_QUERY_CLIENT_COMMAND",
		);
		expect(
			code(() => checkConsoleSql("SELECT 1 /*M! , 2 */", "mysql", ro)),
		).toBe("DATABASE_QUERY_EXECUTABLE_COMMENT");
	});
});
