import { APP_ID } from "#/config/shared.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { internalError } from "#/utils/error.ts";
import { assertContainerName } from "./edge-functions";

/**
 * SQL for the Database Functions tab. Owner SQL and our catalog queries run
 * through `psql -c` inside the db container (`docker exec`, SQL on stdin, so
 * it never appears in host process listings). `-c` sends the text to the
 * server as is: psql meta-commands (`\!` shell escapes, `\copy` …) are not
 * interpreted. Pure builders: the exact commands are unit-tested.
 */

/** Schemas the UI can browse (no quoting surprises in identifiers/URLs). */
const SCHEMA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** SQL identifier, always double-quoted (like `quote_ident` / `%I`). */
export function quoteIdent(value: string): string {
	if (value.length === 0 || value.includes("\0")) {
		throw new TemplateError("SQL_IDENTIFIER_INVALID");
	}
	return `"${value.replace(/"/g, '""')}"`;
}

/**
 * SQL string literal (like `quote_literal`). Uses the `E''` form so it is
 * correct whatever `standard_conforming_strings` is.
 */
export function quoteLiteral(value: string): string {
	if (value.includes("\0")) throw new TemplateError("SQL_LITERAL_INVALID");
	const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "''");
	return `E'${escaped}'`;
}

function assertSchemaName(schema: string): string {
	if (!SCHEMA_NAME_PATTERN.test(schema)) {
		throw new TemplateError("SQL_SCHEMA_INVALID", { schema });
	}
	return schema;
}

function assertOid(oid: number): number {
	if (!Number.isInteger(oid) || oid <= 0 || oid > 4294967295) {
		throw new TemplateError("SQL_FUNCTION_ID_INVALID");
	}
	return oid;
}

export interface PsqlTarget {
	container: string;
	user: string;
	database: string;
	timeoutMs: number;
}

const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * `docker exec -i` psql reading one SQL string from stdin and running it
 * with `-c` (single implicit transaction, ON_ERROR_STOP, no psqlrc).
 * `tuples`: unaligned, tuples only (machine-readable output).
 */
export function psqlCommand(target: PsqlTarget, tuples: boolean): string {
	assertContainerName(target.container);
	if (!ROLE_PATTERN.test(target.user) || !ROLE_PATTERN.test(target.database)) {
		throw internalError("Invalid database user or name");
	}
	const timeout = Math.max(1000, Math.floor(target.timeoutMs));
	const flags = tuples ? "-X -q -A -t" : "-X -q";
	const script = `sql=$(cat); exec psql ${flags} -v ON_ERROR_STOP=1 -U "$1" -d "$2" -c "$sql"`;
	return [
		"docker exec -i",
		`-e ${q(`PGOPTIONS=-c statement_timeout=${timeout}`)}`,
		q(target.container),
		"sh -c",
		q(script),
		"sh",
		q(target.user),
		q(target.database),
	].join(" ");
}

/** Owner SQL must be plain SQL (psql meta-commands are refused). */
export function assertOwnerSql(sql: string, maxBytes: number): string {
	const trimmed = sql.trim();
	if (!trimmed) throw new TemplateError("SQL_EMPTY");
	if (trimmed.startsWith("\\")) {
		throw new TemplateError("SQL_META_COMMAND");
	}
	if (sql.includes("\0")) throw new TemplateError("SQL_NUL");
	if (Buffer.byteLength(sql, "utf8") > maxBytes) {
		throw new TemplateError("SQL_TOO_LARGE", { max: { $bytes: maxBytes } });
	}
	return sql;
}

/** Non-system schemas as a JSON array (pg_* and information_schema excluded). */
export function listSchemasQuery(): string {
	return [
		"SELECT coalesce(json_agg(nspname ORDER BY nspname), '[]'::json)",
		"FROM pg_namespace",
		"WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'",
	].join(" ");
}

/** Functions/procedures of one schema (extension-owned ones excluded). */
export function listFunctionsQuery(schema: string): string {
	return [
		"SELECT coalesce(json_agg(f ORDER BY f.name, f.args), '[]'::json) FROM (",
		"SELECT p.oid::int8 AS oid, n.nspname AS schema, p.proname AS name,",
		"pg_get_function_identity_arguments(p.oid) AS args,",
		"pg_get_function_result(p.oid) AS returns,",
		"l.lanname AS language, p.prokind AS kind,",
		"p.prosecdef AS security_definer,",
		"obj_description(p.oid, 'pg_proc') AS comment",
		"FROM pg_proc p",
		"JOIN pg_namespace n ON n.oid = p.pronamespace",
		"JOIN pg_language l ON l.oid = p.prolang",
		`WHERE n.nspname = ${quoteLiteral(assertSchemaName(schema))}`,
		"AND p.prokind IN ('f', 'p')",
		"AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')",
		") f",
	].join(" ");
}

/** `CREATE OR REPLACE` definition of one function, scoped to its schema. */
export function functionDefinitionQuery(schema: string, oid: number): string {
	return [
		"SELECT pg_get_functiondef(p.oid)",
		"FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace",
		`WHERE p.oid = ${assertOid(oid)}`,
		`AND n.nspname = ${quoteLiteral(assertSchemaName(schema))}`,
		"AND p.prokind IN ('f', 'p')",
	].join(" ");
}

/**
 * Drop one function by oid. The statement is built inside Postgres with
 * `format('%I')`, so identifiers and argument types are quoted by the server.
 */
export function dropFunctionSql(schema: string, oid: number): string {
	return [
		`DO $${APP_ID}_drop$`,
		"DECLARE stmt text;",
		"BEGIN",
		"SELECT format('DROP %s %I.%I(%s)',",
		"CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,",
		"n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))",
		"INTO stmt",
		"FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace",
		`WHERE p.oid = ${assertOid(oid)}`,
		`AND n.nspname = ${quoteLiteral(assertSchemaName(schema))}`,
		"AND p.prokind IN ('f', 'p');",
		"IF stmt IS NULL THEN RAISE EXCEPTION 'function not found'; END IF;",
		"EXECUTE stmt;",
		"END",
		`$${APP_ID}_drop$;`,
	].join("\n");
}

/** Starter SQL for a new function in `schema`. */
export function newFunctionSql(schema: string): string {
	const target = quoteIdent(assertSchemaName(schema));
	return [
		`CREATE OR REPLACE FUNCTION ${target}.hello(name text DEFAULT 'world')`,
		"RETURNS text",
		"LANGUAGE sql",
		"STABLE",
		"AS $$",
		"  SELECT 'Hello, ' || name || '!';",
		"$$;",
	].join("\n");
}

/** First line of psql's error output (`ERROR:  …`) plus LINE/context hints. */
export function formatPsqlError(stderr: string): string {
	const text = stderr.replace(/^psql:[^:]*:\d+: /gm, "").trim();
	return text || "psql failed";
}
