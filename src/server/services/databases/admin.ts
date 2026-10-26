import { databaseEngines } from "#/config/database-engines.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { internalError } from "#/utils/error.ts";
import {
	assertConsoleDatabase,
	assertContainer,
	assertNonce,
	CONSOLE_DATABASE_PATTERN,
	type ConsoleLimits,
	capped,
} from "./console";
import { CONSOLE_ROLES } from "./engines/common";
import { mysqlIdent, mysqlLiteral, pgIdent, pgLiteral } from "./sql";

/**
 * Users and databases management (Postgres, MySQL/MariaDB), pure builders.
 * Statements run as the superuser/root through `docker exec -i` with the
 * SQL on stdin; names are validated and always quoted (`%I`-style for
 * Postgres, backticks for MySQL), passwords are literals sent on stdin.
 */

/** Names the UI may create (quoted anyway). */
const MANAGED_DATABASE_PATTERN = CONSOLE_DATABASE_PATTERN;
const MANAGED_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
/** MySQL account host part. */
const MYSQL_HOST_PATTERN = /^(%|localhost|[A-Za-z0-9_.:%-]{1,255})$/;

export function assertManagedDatabase(name: string): string {
	if (!MANAGED_DATABASE_PATTERN.test(name)) {
		throw new TemplateError("DATABASE_NAME_INVALID", { name });
	}
	return name;
}

export function assertManagedUser(name: string): string {
	if (!MANAGED_USER_PATTERN.test(name)) {
		throw new TemplateError("DATABASE_USER_INVALID", { name });
	}
	return name;
}

/** Databases and users the UI never drops (engine, Nitrobase or the app's own). */
export function protectedNames(
	kind: "postgres" | "mysql",
	main: { user: string; database: string },
): { databases: Set<string>; users: Set<string> } {
	return kind === "postgres"
		? {
				databases: new Set([
					"postgres",
					"template0",
					"template1",
					main.database,
				]),
				users: new Set([...CONSOLE_ROLES, main.user]),
			}
		: {
				databases: new Set([
					"mysql",
					"sys",
					"information_schema",
					"performance_schema",
					main.database,
				]),
				users: new Set([
					"root",
					"mysql.sys",
					"mysql.session",
					"mysql.infoschema",
					"mariadb.sys",
					"healthcheck",
					...CONSOLE_ROLES,
					main.user,
				]),
			};
}

// ---------------------------------------------------------------------------
// Postgres

/** Databases (with size) and roles as one JSON document. */
export function pgListSql(): string {
	return [
		"SELECT json_build_object(",
		"'databases', (SELECT coalesce(json_agg(json_build_object('name', datname, 'owner', pg_get_userbyid(datdba), 'sizeBytes', pg_database_size(oid)) ORDER BY datname), '[]'::json) FROM pg_database WHERE NOT datistemplate),",
		"'users', (SELECT coalesce(json_agg(json_build_object('name', rolname, 'superuser', rolsuper, 'login', rolcanlogin) ORDER BY rolname), '[]'::json) FROM pg_roles WHERE rolname !~ '^pg_')",
		")",
	].join(" ");
}

export function pgCreateDatabaseSql(
	name: string,
	owner: string | null,
): string {
	const owned = owner ? ` OWNER ${pgIdent(assertManagedUser(owner))}` : "";
	return `CREATE DATABASE ${pgIdent(assertManagedDatabase(name))}${owned}`;
}

export function pgCreateUserSql(name: string, password: string): string {
	return `CREATE ROLE ${pgIdent(assertManagedUser(name))} LOGIN PASSWORD ${pgLiteral(password)}`;
}

/**
 * All privileges on a database, plus its `public` schema (Postgres 15+
 * no longer lets everyone create there). The second statement runs while
 * connected to that database.
 */
export function pgGrantSql(
	database: string,
	user: string,
): { cluster: string; inDatabase: string } {
	const role = pgIdent(assertManagedUser(user));
	return {
		cluster: `GRANT ALL PRIVILEGES ON DATABASE ${pgIdent(assertManagedDatabase(database))} TO ${role}`,
		inDatabase: `GRANT ALL ON SCHEMA public TO ${role}`,
	};
}

export function pgDropDatabaseSql(name: string): string {
	return `DROP DATABASE ${pgIdent(assertManagedDatabase(name))} WITH (FORCE)`;
}

export function pgDropUserSql(name: string): string {
	return `DROP ROLE ${pgIdent(assertManagedUser(name))}`;
}

/**
 * psql as `superuser` on `database` running the SQL read from stdin
 * (`-f -`: only SQL Nitrobase generated from validated, quoted names, so a
 * password never sits on a command line; each statement commits on its
 * own, as CREATE/DROP DATABASE need). Tuples-only output, both streams
 * capped in the container (`capped`).
 */
export function pgAdminCommand(input: {
	container: string;
	superuser: string;
	database: string;
	nonce: string;
	limits: ConsoleLimits;
}): string {
	if (!/^[a-z_][a-z0-9_]{0,62}$/.test(input.superuser)) {
		throw internalError("Invalid role");
	}
	const timeout = Math.max(1000, Math.floor(input.limits.timeoutMs));
	const run = `psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$1" -d "$2" -f -`;
	return [
		"docker exec -i",
		`-e ${q(`PGOPTIONS=-c statement_timeout=${timeout}`)}`,
		q(assertContainer(input.container)),
		"sh -c",
		q(capped(run, assertNonce(input.nonce), input.limits)),
		"sh",
		q(input.superuser),
		q(assertConsoleDatabase(input.database)),
	].join(" ");
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB

export function mysqlListSql(): string {
	return [
		"SELECT JSON_OBJECT(",
		"'databases', (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('name', s.schema_name, 'sizeBytes', (SELECT COALESCE(SUM(t.data_length + t.index_length), 0) FROM information_schema.tables t WHERE t.table_schema = s.schema_name))), JSON_ARRAY()) FROM information_schema.schemata s),",
		"'users', (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('name', u.user, 'host', u.host)), JSON_ARRAY()) FROM mysql.user u)",
		");",
	].join(" ");
}

const account = (user: string, host: string) => {
	if (!MYSQL_HOST_PATTERN.test(host)) {
		throw new TemplateError("DATABASE_HOST_INVALID", { host });
	}
	return `${mysqlLiteral(assertManagedUser(user))}@${mysqlLiteral(host)}`;
};

export function mysqlCreateDatabaseSql(name: string): string {
	return `CREATE DATABASE ${mysqlIdent(assertManagedDatabase(name))};`;
}

export function mysqlCreateUserSql(name: string, password: string): string {
	return `CREATE USER ${account(name, "%")} IDENTIFIED BY ${mysqlLiteral(password)};`;
}

export function mysqlGrantSql(
	database: string,
	user: string,
	host: string,
): string {
	return `GRANT ALL PRIVILEGES ON ${mysqlIdent(assertManagedDatabase(database))}.* TO ${account(user, host)};`;
}

export function mysqlDropDatabaseSql(name: string): string {
	return `DROP DATABASE ${mysqlIdent(assertManagedDatabase(name))};`;
}

export function mysqlDropUserSql(name: string, host: string): string {
	return `DROP USER ${account(name, host)};`;
}

/** mysql/mariadb as root reading SQL on stdin (password from the container env). */
export function mysqlAdminCommand(input: {
	kind: "mysql" | "mariadb";
	container: string;
	rootPasswordEnv: string;
	nonce: string;
	limits: ConsoleLimits;
}): string {
	if (!/^[A-Z_][A-Z0-9_]*$/.test(input.rootPasswordEnv)) {
		throw internalError("Invalid password variable");
	}
	const client = databaseEngines[input.kind].cli;
	const run = `MYSQL_PWD="$(printenv ${input.rootPasswordEnv})" ${client} --batch --skip-column-names --raw --protocol=socket -u root`;
	return [
		"docker exec -i",
		q(assertContainer(input.container)),
		"sh -c",
		q(capped(run, assertNonce(input.nonce), input.limits)),
	].join(" ");
}
