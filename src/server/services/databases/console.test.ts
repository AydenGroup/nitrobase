import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const {
	mariadbConsoleGrantsSql,
	mongoConsoleUserScript,
	mysqlConsoleCommand,
	mysqlConsoleScript,
	mysqlConsoleUserSql,
	parseCappedOutput,
	parseCsv,
	parseMysqlBatch,
	postgresConsoleRoleSql,
	psqlConsoleCommand,
} = await import("./console");
const { scanSql } = await import("./sql");

const nonce = "0123456789abcdef0123456789abcdef";
const limits = { timeoutMs: 15000, maxBytes: 1_000_000, maxErrorBytes: 65536 };

describe("psql console command", () => {
	it("read-only: console role, READ ONLY transaction, timeout, rollback", () => {
		const command = psqlConsoleCommand({
			container: "database-0123abcd-db",
			database: "app",
			readOnly: true,
			superuser: "app",
			nonce,
			limits,
		});
		expect(command).toContain("'nitrobase_console' 'app' 15000");
		const script = command.match(/sh -c ('(?:[^']|'\\'')*')/)?.[1] ?? "";
		const unquoted = script.slice(1, -1).replace(/'\\''/g, "'");
		expect(unquoted).toContain(
			`-c 'BEGIN' -c 'SET TRANSACTION READ ONLY' -c "SET LOCAL statement_timeout = $3" -c "$sql" -c 'ROLLBACK'`,
		);
		expect(command).toContain("default_transaction_read_only=on");
		expect(command).toContain("sql=$(cat)");
		expect(command).toContain(`__nitrobase_exit_${nonce}__`);
		expect(command).toContain("head -c 1000000");
		expect(command.startsWith("docker exec -i ")).toBe(true);
	});

	it("write: superuser, no read-only transaction", () => {
		const command = psqlConsoleCommand({
			container: "database-0123abcd-db",
			database: "app",
			readOnly: false,
			superuser: "app",
			nonce,
			limits,
		});
		expect(command).not.toContain("READ ONLY");
		expect(command).not.toContain("nitrobase_console");
		expect(command).toContain("'app' 'app' 15000");
	});

	it("refuses conninfo-like database names and odd containers", () => {
		const input = {
			container: "database-0123abcd-db",
			database: "app",
			readOnly: true,
			superuser: "app",
			nonce,
			limits,
		};
		expect(() =>
			psqlConsoleCommand({ ...input, database: "host=evil" }),
		).toThrow();
		expect(() => psqlConsoleCommand({ ...input, container: "x;rm" })).toThrow();
		expect(() => psqlConsoleCommand({ ...input, nonce: "x" })).toThrow();
	});
});

describe("mysql console", () => {
	const statements = scanSql("SELECT 1; SELECT 'a;b' AS x", "mysql").statements;

	it("read-only script: session read-only, START TRANSACTION READ ONLY, marker, rollback", () => {
		const script = mysqlConsoleScript({
			kind: "mysql",
			statements,
			readOnly: true,
			nonce,
			timeoutMs: 15000,
		});
		const lines = script.split("\n");
		expect(lines[0]).toBe("SET SESSION TRANSACTION READ ONLY;");
		expect(lines[1]).toBe("SET SESSION max_execution_time = 15000;");
		expect(lines[2]).toBe("START TRANSACTION READ ONLY;");
		expect(script).toContain(
			`SELECT '__nitrobase_result_${nonce}__' AS \`__nitrobase_result_${nonce}__\`;\nSELECT 'a;b' AS x\n;`,
		);
		expect(script.trim().endsWith("ROLLBACK;")).toBe(true);
	});

	it("mariadb uses max_statement_time in seconds; write mode has no transaction", () => {
		const script = mysqlConsoleScript({
			kind: "mariadb",
			statements,
			readOnly: false,
			nonce,
			timeoutMs: 1500,
		});
		expect(script).toContain("SET SESSION max_statement_time = 1.500;");
		expect(script).not.toContain("READ ONLY");
		expect(script).not.toContain("ROLLBACK");
	});

	it("passwords come from the container env, never argv", () => {
		const ro = mysqlConsoleCommand({
			kind: "mysql",
			container: "database-0123abcd-db",
			database: "app",
			readOnly: true,
			rootPasswordEnv: "MYSQL_ROOT_PASSWORD",
			nonce,
			limits,
		});
		expect(ro).toContain('MYSQL_PWD="$(printenv NITROBASE_CONSOLE_PASSWORD)"');
		expect(ro).toContain("'nitrobase_console' 'app'");
		const rw = mysqlConsoleCommand({
			kind: "mariadb",
			container: "database-0123abcd-db",
			database: "app",
			readOnly: false,
			rootPasswordEnv: "MARIADB_ROOT_PASSWORD",
			nonce,
			limits,
		});
		expect(rw).toContain(
			'MYSQL_PWD="$(printenv MARIADB_ROOT_PASSWORD)" mariadb',
		);
		expect(rw).toContain("'root' 'app'");
	});
});

describe("output parsing", () => {
	it("splits the exit marker from the output", () => {
		const out = parseCappedOutput(
			`a,b\n1,2\n\n__nitrobase_exit_${nonce}__:0\n`,
			nonce,
		);
		expect(out).toEqual({ body: "a,b\n1,2\n", exitCode: 0, truncated: false });
		expect(parseCappedOutput("a,b\n1,", nonce).truncated).toBe(true);
		expect(
			parseCappedOutput(`\n__nitrobase_exit_${nonce}__:3\n`, nonce).exitCode,
		).toBe(3);
		// Output trimmed by the executor: the marker starts the text.
		expect(parseCappedOutput(`__nitrobase_exit_${nonce}__:1`, nonce)).toEqual({
			body: "",
			exitCode: 1,
			truncated: false,
		});
		// Query output can't fake another run's marker.
		expect(
			parseCappedOutput("__nitrobase_exit_other__:0\n", nonce).truncated,
		).toBe(true);
	});

	it("parses psql CSV with quotes and newlines, capped", () => {
		const grid = parseCsv('id,name\n1,"a, ""b""\nc"\n2,\n3,x\n', 2);
		expect(grid.columns).toEqual(["id", "name"]);
		expect(grid.rows).toEqual([
			["1", 'a, "b"\nc'],
			["2", ""],
		]);
		expect(grid.truncated).toBe(true);
	});

	it("parses the mysql batch result after the marker", () => {
		const marker = `__nitrobase_result_${nonce}__`;
		const body = [
			"1",
			"1",
			marker,
			marker,
			"id\tname",
			"1\ta\\tb",
			"2\tNULL",
			"",
		].join("\n");
		expect(parseMysqlBatch(body, nonce, 10)).toEqual({
			columns: ["id", "name"],
			rows: [
				["1", "a\tb"],
				["2", null],
			],
			truncated: false,
		});
		expect(parseMysqlBatch(`${marker}\n${marker}\n`, nonce, 10)).toBeNull();
	});
});

describe("console logins", () => {
	it("postgres: read-only role without password, pg_read_all_data", () => {
		const sql = postgresConsoleRoleSql().join("\n");
		expect(sql).toContain("PASSWORD NULL");
		expect(sql).toContain("NOSUPERUSER");
		expect(sql).toContain(
			'GRANT pg_read_all_data, pg_read_all_stats TO "nitrobase_console"',
		);
		expect(sql).toContain("default_transaction_read_only = on");
	});

	it("mysql: localhost-only, SELECT only, never mysql.*", () => {
		const sql = mysqlConsoleUserSql("Abc123", "mysql");
		expect(sql).toContain(
			"'nitrobase_console'@'localhost' IDENTIFIED BY 'Abc123'",
		);
		expect(sql).toContain("SET PERSIST partial_revokes = ON;");
		expect(sql).toContain("GRANT SELECT, SHOW VIEW ON *.*");
		expect(sql).toContain("REVOKE SELECT, SHOW VIEW ON mysql.*");
		expect(sql).not.toMatch(/GRANT ALL/);
	});

	it("mariadb: grants per database, system schemas excluded", () => {
		const sql = mysqlConsoleUserSql("Abc123", "mariadb");
		expect(sql).not.toContain("ON *.*");
		expect(sql).toContain("REVOKE ALL PRIVILEGES, GRANT OPTION FROM");
		expect(sql).toContain(
			"NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')",
		);
		expect(sql).toContain("'`.* TO ''nitrobase_console''@''localhost''')");
		expect(sql.trim().endsWith("DELIMITER ;")).toBe(true);
	});

	it("drop no other login; MariaDB grants the console login when it exists", () => {
		expect(postgresConsoleRoleSql().join("\n")).not.toContain("DROP ROLE");
		expect(mysqlConsoleUserSql("Abc123", "mysql")).not.toContain("DROP USER");
		const grants = mariadbConsoleGrantsSql();
		expect(grants).toContain(
			"IF EXISTS (SELECT 1 FROM mysql.user WHERE user = 'nitrobase_console' AND host = 'localhost') THEN",
		);
		expect(grants.match(/IF EXISTS/g)).toHaveLength(1);
		expect(mongoConsoleUserScript()).not.toContain("dropUser");
	});
});

/** Run the `sh -c` script of a console command against stub clients. */
function runConsole(command: string, env: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "console-login-"));
	try {
		// psql: every login as a role the database lacks ($MISSING) fails.
		writeFileSync(
			path.join(dir, "psql"),
			[
				"#!/bin/sh",
				'u=""; prev=""',
				'for a; do [ "$prev" = "-U" ] && u="$a"; prev="$a"; done',
				'[ -n "$MISSING" ] && [ "$u" = "$MISSING" ] && exit 2',
				'echo "psql $*"',
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		writeFileSync(
			path.join(dir, "mysql"),
			'#!/bin/sh\necho "mysql $* pwd=$MYSQL_PWD"\n',
			{ mode: 0o755 },
		);
		const args = command.match(/sh -c ('(?:[^']|'\\'')*') sh (.*)$/);
		if (!args) throw new Error("no script");
		const script = args[1].slice(1, -1).replace(/'\\''/g, "'");
		const rest = [...args[2].matchAll(/'([^']*)'|(\S+)/g)].map(
			(m) => m[1] ?? m[2],
		);
		return execFileSync("sh", ["-c", script, "sh", ...rest], {
			encoding: "utf8",
			input: "SELECT 1",
			env: {
				PATH: `${dir}:/usr/bin:/bin`,
				...env,
			} as unknown as NodeJS.ProcessEnv,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("console login of a read-only run", () => {
	const ro = { container: "c", database: "app", nonce, limits };

	it("mysql: the console login with its variable", () => {
		const command = mysqlConsoleCommand({
			...ro,
			kind: "mysql",
			readOnly: true,
			rootPasswordEnv: "MYSQL_ROOT_PASSWORD",
		});
		expect(
			runConsole(command, { NITROBASE_CONSOLE_PASSWORD: "new" }),
		).toContain("-u nitrobase_console -D app pwd=new");
	});

	it("postgres: the console login, no fallback", () => {
		const command = psqlConsoleCommand({
			...ro,
			readOnly: true,
			superuser: "app",
		});
		expect(runConsole(command, {})).toContain("-U nitrobase_console -d app");
		expect(runConsole(command, { MISSING: "nitrobase_console" })).not.toContain(
			"psql ",
		);
	});
});
