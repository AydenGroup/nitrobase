/**
 * How a hosted Supabase database is dumped for a new project: a port of
 * the Supabase CLI's `db dump` scripts (supabase/cli
 * apps/cli-go/pkg/migration/dump.go + scripts/dump_{role,schema,data}.sh),
 * as data plus pure functions. The roles and schema dumps are rewritten
 * line by line (`transformDump`) like the scripts' `sed` pipeline; the data
 * dump is loaded as pg_dump wrote it (the restoring psql understands its
 * `\restrict` lines).
 */

/** Schemas the platform or extensions own: never in the schema dump. */
export const SCHEMA_DUMP_EXCLUDED = [
	"information_schema",
	"pg_*",
	"_analytics",
	"_realtime",
	"_supavisor",
	"auth",
	"etl",
	"extensions",
	"pgbouncer",
	"realtime",
	"storage",
	"supabase_functions",
	"supabase_migrations",
	"cron",
	"dbdev",
	"graphql",
	"graphql_public",
	"net",
	"pgmq",
	"pgsodium",
	"pgsodium_masks",
	"pgtle",
	"repack",
	"tiger",
	"tiger_data",
	"timescaledb_*",
	"_timescaledb_*",
	"topology",
	"vault",
] as const;

/**
 * Schemas left out of the data dump: narrower, so auth users (with their
 * sessions and refresh tokens), storage metadata and queue tables move
 * with the data. Extension configuration tables (`cron.job`, …) do not:
 * see `dumpArgs("data")`; cron jobs have their own step (supabase-cron.ts).
 */
export const DATA_DUMP_EXCLUDED = [
	"information_schema",
	"pg_*",
	"graphql",
	"graphql_public",
	"pgsodium",
	"pgsodium_masks",
	"pgtle",
	"repack",
	"tiger",
	"tiger_data",
	"timescaledb_*",
	"_timescaledb_*",
	"topology",
	"vault",
	"etl",
	"extensions",
	"pgbouncer",
	"realtime",
	"supabase_migrations",
	"_analytics",
	"_realtime",
	"_supavisor",
] as const;

/** Migration history and platform-managed tables: the new app has its own. */
const DATA_DUMP_EXCLUDED_TABLES = [
	"auth.schema_migrations",
	"storage.migrations",
	"supabase_functions.migrations",
	"storage.buckets_vectors",
	"storage.vector_indexes",
] as const;

/** Roles the platform creates (regex alternatives, as in the CLI). */
export const RESERVED_ROLES = [
	"anon",
	"authenticated",
	"authenticator",
	"cli_login_.*",
	"dashboard_user",
	"pgbouncer",
	"postgres",
	"service_role",
	"supabase_.*",
	"pgsodium_keyholder",
	"pgsodium_keyiduser",
	"pgsodium_keymaker",
	"pgtle_admin",
] as const;

/** Role settings a non-superuser may keep (supautils allow-list). */
const ALLOWED_ROLE_CONFIGS = [
	"pgaudit.*",
	"pgrst.*",
	"session_replication_role",
	"statement_timeout",
	"track_io_timing",
] as const;

/** `pg_*` (a pg_dump glob) → `pg_.*` (a regex alternative). */
const globToRegex = (glob: string) =>
	glob
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");

const alternatives = (items: readonly string[], glob: boolean) =>
	items.map((item) => (glob ? globToRegex(item) : item)).join("|");

export interface LineRule {
	/** Matched against one line (no trailing newline). */
	pattern: RegExp;
	/** `comment`: prefix `-- `; a string: replacement (`$1`…); `drop`. */
	action: "comment" | "drop" | string;
}

const comment = (pattern: RegExp): LineRule => ({ pattern, action: "comment" });

/** psql meta-commands pg_dump ≥ 17.6 writes (commented like the CLI). */
const RESTRICT = comment(/^\\(un)?restrict .*$/);

/** Rules of dump_role.sh, in order. */
function roleRules(): LineRule[] {
	const reserved = alternatives(RESERVED_ROLES, false);
	const configs = alternatives(ALLOWED_ROLE_CONFIGS, false);
	return [
		RESTRICT,
		comment(new RegExp(`^CREATE ROLE "(${reserved})"`)),
		comment(new RegExp(`^ALTER ROLE "(${reserved})"`)),
		// Attributes only a superuser may set are dropped from the statement.
		{ pattern: / (NOSUPERUSER|NOREPLICATION)/g, action: "" },
		{ pattern: new RegExp(`^-- (.* SET "(${configs})" .*)`), action: "$1" },
		comment(new RegExp(`GRANT ".*" TO "(${reserved})"`)),
		// --no-comments: SQL comments are removed (EXTRA_SED=/^--/d).
		{ pattern: /^--/, action: "drop" },
	];
}

/** Rules of dump_schema.sh, in order. */
function schemaRules(): LineRule[] {
	const excluded = alternatives(SCHEMA_DUMP_EXCLUDED, true);
	return [
		RESTRICT,
		{ pattern: /^CREATE SCHEMA "/, action: 'CREATE SCHEMA IF NOT EXISTS "' },
		{ pattern: /^CREATE TABLE "/, action: 'CREATE TABLE IF NOT EXISTS "' },
		{
			pattern: /^CREATE SEQUENCE "/,
			action: 'CREATE SEQUENCE IF NOT EXISTS "',
		},
		{ pattern: /^CREATE VIEW "/, action: 'CREATE OR REPLACE VIEW "' },
		{ pattern: /^CREATE FUNCTION "/, action: 'CREATE OR REPLACE FUNCTION "' },
		{ pattern: /^CREATE TRIGGER "/, action: 'CREATE OR REPLACE TRIGGER "' },
		comment(/^CREATE PUBLICATION "supabase_realtime/),
		comment(/^CREATE EVENT TRIGGER /),
		comment(/^ {9}WHEN TAG IN /),
		comment(/^ {3}EXECUTE FUNCTION /),
		comment(/^ALTER EVENT TRIGGER /),
		comment(/^ALTER PUBLICATION "supabase_realtime_/),
		comment(/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /),
		comment(/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/),
		comment(
			/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/,
		),
		comment(new RegExp(`^GRANT (.+) ON (.+) "(${excluded})"`)),
		comment(new RegExp(`^REVOKE (.+) ON (.+) "(${excluded})"`)),
		{
			pattern: /^(CREATE EXTENSION IF NOT EXISTS "pg_tle").+/,
			action: "$1;",
		},
		{
			pattern: /^(CREATE EXTENSION IF NOT EXISTS "pgsodium").+/,
			action: "$1;",
		},
		{ pattern: /^(CREATE EXTENSION IF NOT EXISTS "pgmq").+/, action: "$1;" },
		comment(/^COMMENT ON EXTENSION (.+)/),
		comment(/^CREATE POLICY "cron_job_/),
		comment(/^ALTER TABLE "cron"/),
		comment(/^SET transaction_timeout = 0;/),
		{ pattern: /^--/, action: "drop" },
	];
}

/**
 * Apply `rules` to every line like a `sed -E` pipeline: each rule sees the
 * previous one's output; a dropped line stops there. Role dumps also fold
 * repeated lines (`uniq`) and end with `RESET ALL;`.
 */
function transformDump(
	text: string,
	rules: LineRule[],
	options: { uniq?: boolean; trailer?: string } = {},
): string {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		let line: string | null = raw;
		for (const rule of rules) {
			if (line === null) break;
			const pattern: RegExp = rule.pattern;
			pattern.lastIndex = 0;
			if (!pattern.test(line)) continue;
			pattern.lastIndex = 0;
			if (rule.action === "drop") line = null;
			else if (rule.action === "comment") line = `-- ${line}`;
			else line = line.replace(pattern, rule.action);
		}
		if (line === null) continue;
		if (options.uniq && out.length > 0 && out[out.length - 1] === line) {
			continue;
		}
		out.push(line);
	}
	if (options.trailer) out.push(options.trailer);
	return out.join("\n");
}

export const transformRoleDump = (text: string) =>
	transformDump(text, roleRules(), { uniq: true, trailer: "RESET ALL;\n" });

export const transformSchemaDump = (text: string) =>
	transformDump(text, schemaRules());

/** pg_dumpall/pg_dump arguments of the three dumps (written to `file`). */
export type DumpKind = "roles" | "schema" | "data" | "vault";

/**
 * Tables an export leaves out of the data dump on top of the import's:
 * in-flight multipart uploads (their parts live in the app's storage
 * backend only).
 */
export const EXPORT_EXCLUDED_TABLES = [
	"storage.s3_multipart_uploads",
	"storage.s3_multipart_uploads_parts",
] as const;

/** `storage.objects`: left out when storage files are not exported. */
export const STORAGE_OBJECTS_TABLE = "storage.objects";

export function dumpArgs(
	kind: DumpKind,
	file: string,
	options: { excludeTables?: readonly string[] } = {},
): string[] {
	const common = ["--quote-all-identifier", "--role", "postgres", "-f", file];
	if (kind === "vault") {
		// Vault rows, only when the project's root key is copied too.
		return [
			"pg_dump",
			"--data-only",
			...common,
			"--table",
			'"vault"."secrets"',
		];
	}
	if (kind === "roles") {
		return [
			"pg_dumpall",
			"--roles-only",
			"--no-role-passwords",
			"--no-comments",
			...common,
		];
	}
	if (kind === "schema") {
		return [
			"pg_dump",
			"--schema-only",
			...common,
			...SCHEMA_DUMP_EXCLUDED.flatMap((schema) => ["--exclude-schema", schema]),
		];
	}
	return [
		"pg_dump",
		"--data-only",
		...common,
		...DATA_DUMP_EXCLUDED.flatMap((schema) => ["--exclude-schema", schema]),
		...[...DATA_DUMP_EXCLUDED_TABLES, ...(options.excludeTables ?? [])].flatMap(
			(table) => [
				"--exclude-table",
				table.replace(/^([^.]+)\.(.+)$/, '"$1"."$2"'),
			],
		),
		// Kept on purpose (as the CLI's dump_data.sh): any --schema makes
		// pg_dump leave out the data of extension configuration tables
		// (pg_extension_config_dump: cron.job, cron.job_run_details, …).
		// Their rows cannot be COPYed by the restoring role (owner, row
		// security, clashing ids); cron jobs are copied by their own step.
		"--schema",
		"*",
	];
}

/** Schemas whose tables are compared row by row after an import. */
export function isUserSchema(schema: string): boolean {
	return !new RegExp(`^(${alternatives(SCHEMA_DUMP_EXCLUDED, true)})$`).test(
		schema,
	);
}
