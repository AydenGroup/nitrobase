import { databaseEngines } from "#/config/database-engines.ts";
import { APP_ID } from "#/config/shared.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { internalError } from "#/utils/error.ts";
import { CONSOLE_PASSWORD_ENV, CONSOLE_ROLE } from "./engines/common";
import { mysqlLiteral, pgIdent, type SqlStatement } from "./sql";

/**
 * Console command builders (pure, tested). Everything runs through
 * `docker exec -i` in the database container with the user's input on
 * stdin (never on a command line), output capped in the container
 * (`head -c`) and followed by an exit marker carrying a per-run nonce, so
 * query output can't fake it and a cut-off output is detected.
 *
 * Read-only runs log in as CONSOLE_ROLE (can only read) and, for SQL,
 * inside a READ ONLY transaction with a statement timeout: Postgres
 * `BEGIN; SET TRANSACTION READ ONLY`, MySQL `START TRANSACTION READ ONLY`
 * after `SET SESSION TRANSACTION READ ONLY`. Write runs log in as the
 * database's superuser/root.
 */

const CONTAINER_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;
/** Database names the console connects to (psql would read `a=b` as a conninfo string). */
export const CONSOLE_DATABASE_PATTERN = /^[A-Za-z_][A-Za-z0-9_$-]{0,63}$/;
const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export interface ConsoleLimits {
	timeoutMs: number;
	/** Output read back (stdout, cut off: the client is stopped). */
	maxBytes: number;
	/** Error output read back (the rest is drained, so the client finishes). */
	maxErrorBytes: number;
}

export function assertContainer(container: string): string {
	if (!CONTAINER_PATTERN.test(container)) {
		throw internalError("Invalid container");
	}
	return container;
}

export function assertConsoleDatabase(name: string): string {
	if (!CONSOLE_DATABASE_PATTERN.test(name)) {
		throw new TemplateError("DATABASE_NAME_INVALID", { name });
	}
	return name;
}

const exitMarker = (nonce: string) => `__${APP_ID}_exit_${nonce}__`;

export function assertNonce(nonce: string): string {
	if (!/^[a-f0-9]{16,64}$/.test(nonce)) throw internalError("Invalid nonce");
	return nonce;
}

/**
 * Run `command` with both streams capped inside the container (POSIX sh):
 * stdout is cut after `maxBytes` (the client is stopped by SIGPIPE: no
 * reading a whole table), stderr keeps its last `maxErrorBytes` (`tail`
 * drains the rest: a NOTICE flood can't fill the panel's memory, the client
 * still finishes, and the final ERROR line is the part kept). The exit status follows on stdout as a marker
 * with the run's nonce.
 */
export function capped(
	command: string,
	nonce: string,
	limits: Pick<ConsoleLimits, "maxBytes" | "maxErrorBytes">,
): string {
	const out = Math.max(1024, Math.floor(limits.maxBytes));
	const err = Math.max(1024, Math.floor(limits.maxErrorBytes));
	return `{ { { ${command}; s=$?; echo >&4; echo "${exitMarker(nonce)}:$s" >&4; } 2>&1 1>&3 3>&- | tail -c ${err} >&2; } 4>&1 1>&3; } 3>&1 | head -c ${out}`;
}

// ---------------------------------------------------------------------------
// Postgres

/**
 * psql running the SQL read from stdin. Read-only: as CONSOLE_ROLE inside
 * `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout`, then
 * ROLLBACK. Write: as `superuser`, autocommit. `-c` sends the SQL as is:
 * psql meta-commands are never interpreted. CSV output (header + rows) of
 * the last statement.
 */
export function psqlConsoleCommand(input: {
	container: string;
	database: string;
	readOnly: boolean;
	/** Superuser for write runs (the database's main user). */
	superuser: string;
	nonce: string;
	limits: ConsoleLimits;
}): string {
	const user = input.readOnly ? CONSOLE_ROLE : input.superuser;
	if (!ROLE_PATTERN.test(user)) throw internalError("Invalid role");
	const timeout = Math.max(1000, Math.floor(input.limits.timeoutMs));
	const flags = `-X -q --csv -v ON_ERROR_STOP=1 -U "$1" -d "$2"`;
	const run = input.readOnly
		? `psql ${flags} -c 'BEGIN' -c 'SET TRANSACTION READ ONLY' -c "SET LOCAL statement_timeout = $3" -c "$sql" -c 'ROLLBACK'`
		: `psql ${flags} -c "SET statement_timeout = $3" -c "$sql"`;
	const script = `sql=$(cat); ${capped(run, assertNonce(input.nonce), input.limits)}`;
	return [
		"docker exec -i",
		`-e ${q(`PGOPTIONS=-c statement_timeout=${timeout}${input.readOnly ? " -c default_transaction_read_only=on" : ""}`)}`,
		q(assertContainer(input.container)),
		"sh -c",
		q(script),
		"sh",
		q(user),
		q(assertConsoleDatabase(input.database)),
		String(timeout),
	].join(" ");
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB

/** Marker row printed before the last statement's result. */
function mysqlResultMarker(nonce: string): string {
	return `__${APP_ID}_result_${assertNonce(nonce)}__`;
}

/**
 * The script the mysql client reads on stdin: session limits, the read-only
 * transaction, the statements, a marker row before the last one (only its
 * result is shown), ROLLBACK.
 */
export function mysqlConsoleScript(input: {
	kind: "mysql" | "mariadb";
	statements: SqlStatement[];
	readOnly: boolean;
	nonce: string;
	timeoutMs: number;
}): string {
	const ms = Math.max(1000, Math.floor(input.timeoutMs));
	const marker = mysqlResultMarker(input.nonce);
	const lines: string[] = [];
	if (input.readOnly) lines.push("SET SESSION TRANSACTION READ ONLY;");
	lines.push(
		input.kind === "mysql"
			? `SET SESSION max_execution_time = ${ms};`
			: `SET SESSION max_statement_time = ${(ms / 1000).toFixed(3)};`,
	);
	if (input.readOnly) lines.push("START TRANSACTION READ ONLY;");
	const statements = input.statements.map((statement) => statement.text);
	const last = statements.pop();
	for (const statement of statements) lines.push(`${statement}\n;`);
	lines.push(`SELECT ${mysqlLiteral(marker)} AS ${"`"}${marker}${"`"};`);
	if (last) lines.push(`${last}\n;`);
	if (input.readOnly) lines.push("ROLLBACK;");
	return `${lines.join("\n")}\n`;
}

/**
 * mysql/mariadb client reading the script on stdin, batch (tab-separated)
 * output. The password comes from an env var inside the container
 * (MYSQL_PWD), never from a command line.
 */
export function mysqlConsoleCommand(input: {
	kind: "mysql" | "mariadb";
	container: string;
	database: string;
	readOnly: boolean;
	/** Env var holding the root password (write runs). */
	rootPasswordEnv: string;
	nonce: string;
	limits: ConsoleLimits;
}): string {
	const client = databaseEngines[input.kind].cli;
	const user = input.readOnly ? CONSOLE_ROLE : "root";
	const passwordEnv = input.readOnly
		? CONSOLE_PASSWORD_ENV
		: input.rootPasswordEnv;
	if (!/^[A-Z_][A-Z0-9_]*$/.test(passwordEnv)) {
		throw internalError("Invalid password variable");
	}
	const client_ = `${client} --batch --column-names --protocol=socket -u "$1" -D "$2"`;
	const run = `MYSQL_PWD="$(printenv ${passwordEnv})" ${client_}`;
	const script = capped(run, assertNonce(input.nonce), input.limits);
	return [
		"docker exec -i",
		q(assertContainer(input.container)),
		"sh -c",
		q(script),
		"sh",
		q(user),
		q(assertConsoleDatabase(input.database)),
	].join(" ");
}

// ---------------------------------------------------------------------------
// Output parsing

export interface ConsoleOutput {
	/** Text before the exit marker. */
	body: string;
	/** Exit status of the client (null: the output was cut off). */
	exitCode: number | null;
	truncated: boolean;
}

/** Split the capped output into the client's output and its exit code. */
export function parseCappedOutput(
	stdout: string,
	nonce: string,
): ConsoleOutput {
	const marker = exitMarker(nonce);
	// At a line start (the executor may trim leading whitespace of the
	// output when the client printed nothing).
	const at = stdout.lastIndexOf(`${marker}:`);
	if (at === -1 || (at > 0 && stdout[at - 1] !== "\n")) {
		return { body: stdout, exitCode: null, truncated: true };
	}
	const code = Number.parseInt(stdout.slice(at + marker.length + 1), 10);
	// The newline before the marker is the one `echo` added.
	const body = stdout.slice(0, Math.max(0, at - 1));
	return { body, exitCode: Number.isNaN(code) ? null : code, truncated: false };
}

export interface ResultGrid {
	columns: string[];
	rows: (string | null)[][];
	/** More rows than the cap (or the output was cut off). */
	truncated: boolean;
}

/** RFC 4180 CSV (psql --csv): header line, quoted fields may hold newlines. */
export function parseCsv(text: string, maxRows: number): ResultGrid {
	const records: string[][] = [];
	let field = "";
	let record: string[] = [];
	let quoted = false;
	let wasQuoted = false;
	let truncated = false;
	const pushField = () => {
		record.push(field);
		field = "";
		wasQuoted = false;
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += c;
			continue;
		}
		if (c === '"' && field === "" && !wasQuoted) {
			quoted = true;
			wasQuoted = true;
		} else if (c === ",") pushField();
		else if (c === "\n") {
			pushField();
			records.push(record);
			record = [];
			if (records.length > maxRows + 1) {
				truncated = true;
				break;
			}
		} else if (c !== "\r") field += c;
	}
	if (!truncated && (field !== "" || record.length > 0)) {
		pushField();
		records.push(record);
	}
	const [columns = [], ...rows] = records;
	return {
		columns,
		rows: rows.slice(0, maxRows),
		truncated: truncated || rows.length > maxRows,
	};
}

const TSV_ESCAPES: Record<string, string> = {
	"\\": "\\",
	t: "\t",
	n: "\n",
	"0": "\0",
	r: "\r",
};

/** One mysql --batch field (`\t` `\n` `\\` `\0` escaped; NULL as is). */
function unescapeTsv(value: string): string | null {
	if (value === "NULL") return null;
	return value.replace(/\\(.)/g, (match, char: string) =>
		char in TSV_ESCAPES ? TSV_ESCAPES[char] : match,
	);
}

/**
 * mysql --batch output after the marker row: the last statement's result
 * set (header + rows), or nothing for a statement without one.
 */
export function parseMysqlBatch(
	body: string,
	nonce: string,
	maxRows: number,
): ResultGrid | null {
	const marker = mysqlResultMarker(nonce);
	const lines = body.split("\n");
	let index = -1;
	for (let i = lines.length - 2; i >= 0; i--) {
		if (lines[i] === marker && lines[i + 1] === marker) {
			index = i + 2;
			break;
		}
	}
	if (index === -1) return null;
	const rest = lines.slice(index).filter((line, i, all) => {
		// Trailing empty line from the output's final newline.
		return !(i === all.length - 1 && line === "");
	});
	if (rest.length === 0) return null;
	const [header, ...rows] = rest;
	return {
		columns: header.split("\t"),
		rows: rows
			.slice(0, maxRows)
			.map((line) => line.split("\t").map(unescapeTsv)),
		truncated: rows.length > maxRows,
	};
}

// ---------------------------------------------------------------------------
// Console role setup (after every deploy; idempotent)

/** Postgres: CONSOLE_ROLE can log in on the local socket only and read everything. */
export function postgresConsoleRoleSql(): string[] {
	const role = pgIdent(CONSOLE_ROLE);
	return [
		`DO $${APP_ID}$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${CONSOLE_ROLE}') THEN CREATE ROLE ${role} LOGIN; END IF; END $${APP_ID}$`,
		// No password: TCP logins (scram) are impossible, the container's
		// local socket (trust) is the only way in.
		`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL`,
		`GRANT pg_read_all_data, pg_read_all_stats TO ${role}`,
		`ALTER ROLE ${role} SET default_transaction_read_only = on`,
	];
}

/** Schemas the read-only console login never reads (users, password hashes). */
const MYSQL_SYSTEM_SCHEMAS = [
	"mysql",
	"information_schema",
	"performance_schema",
	"sys",
];

/**
 * MySQL/MariaDB: CONSOLE_ROLE on localhost (socket) with SELECT and SHOW
 * VIEW only, never on `mysql.*` (password hashes). MySQL 8: a global grant
 * with a partial revoke (`partial_revokes` turned on, persisted). MariaDB
 * has no partial revokes: grants per database (`mariadbConsoleGrantsSql`,
 * refreshed before each read-only run).
 */
export function mysqlConsoleUserSql(
	password: string,
	kind: "mysql" | "mariadb",
): string {
	const user = `${mysqlLiteral(CONSOLE_ROLE)}@'localhost'`;
	const pw = mysqlLiteral(password);
	const lines = [
		// A restored dump may have replaced mysql.user without reloading it.
		"FLUSH PRIVILEGES;",
		`CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY ${pw};`,
		`ALTER USER ${user} IDENTIFIED BY ${pw};`,
		`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${user};`,
	];
	if (kind === "mysql") {
		lines.push(
			"SET PERSIST partial_revokes = ON;",
			`GRANT SELECT, SHOW VIEW ON *.* TO ${user};`,
			`REVOKE SELECT, SHOW VIEW ON mysql.* FROM ${user};`,
		);
		return `${lines.join("\n")}\n`;
	}
	return `${lines.join("\n")}\n${mariadbConsoleGrantsSql()}`;
}

/**
 * MariaDB: SELECT, SHOW VIEW on every non-system database for the console
 * login (CONSOLE_ROLE, when it exists).
 */
export function mariadbConsoleGrantsSql(): string {
	const excluded = MYSQL_SYSTEM_SCHEMAS.map(mysqlLiteral).join(", ");
	const grants = [CONSOLE_ROLE].flatMap((role) => [
		`  IF EXISTS (SELECT 1 FROM mysql.user WHERE user = ${mysqlLiteral(role)} AND host = 'localhost') THEN`,
		`    FOR d IN (SELECT schema_name AS n FROM information_schema.schemata WHERE schema_name NOT IN (${excluded})) DO`,
		`      EXECUTE IMMEDIATE CONCAT('GRANT SELECT, SHOW VIEW ON \`', REPLACE(d.n, '\`', '\`\`'), '\`.* TO ''${role}''@''localhost''');`,
		"    END FOR;",
		"  END IF;",
	]);
	return [
		"DELIMITER $$",
		"BEGIN NOT ATOMIC",
		...grants,
		"END$$",
		"DELIMITER ;",
		"",
	].join("\n");
}

/** MongoDB (mongosh script): CONSOLE_ROLE with readAnyDatabase. */
export function mongoConsoleUserScript(): string {
	return [
		'const admin = db.getSiblingDB("admin");',
		"admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);",
		`const pwd = process.env.${CONSOLE_PASSWORD_ENV};`,
		`const spec = { pwd, roles: [{ role: "readAnyDatabase", db: "admin" }] };`,
		`if (admin.getUser(${JSON.stringify(CONSOLE_ROLE)})) admin.updateUser(${JSON.stringify(CONSOLE_ROLE)}, spec);`,
		`else admin.createUser({ user: ${JSON.stringify(CONSOLE_ROLE)}, ...spec });`,
		'print("ok");',
	].join("\n");
}
