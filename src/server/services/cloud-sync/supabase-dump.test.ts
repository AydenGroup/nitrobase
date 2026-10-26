import { describe, expect, it } from "vitest";
import {
	DATA_DUMP_EXCLUDED,
	dumpArgs,
	isUserSchema,
	SCHEMA_DUMP_EXCLUDED,
	transformRoleDump,
	transformSchemaDump,
} from "./supabase-dump";

describe("role dump transform (dump_role.sh)", () => {
	const dump = [
		"--",
		"-- PostgreSQL database cluster dump",
		"--",
		"\\restrict abc123",
		'CREATE ROLE "anon";',
		'ALTER ROLE "anon" WITH NOSUPERUSER INHERIT NOCREATEROLE;',
		'CREATE ROLE "supabase_storage_admin";',
		'CREATE ROLE "reporting";',
		'ALTER ROLE "reporting" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS;',
		'ALTER ROLE "authenticator" SET "statement_timeout" TO \'8s\';',
		'ALTER ROLE "authenticator" SET "search_path" TO \'x\';',
		'GRANT "reporting" TO "postgres" GRANTED BY "supabase_admin";',
		'GRANT "pg_read_all_data" TO "reporting";',
		'GRANT "pg_read_all_data" TO "reporting";',
		"\\unrestrict abc123",
	].join("\n");
	const out = transformRoleDump(dump).split("\n");

	it("drops psql meta-commands, comments and reserved roles", () => {
		expect(out.some((line) => line.startsWith("\\"))).toBe(false);
		expect(out.some((line) => line.startsWith("--"))).toBe(false);
		expect(out.join("\n")).not.toContain('CREATE ROLE "anon"');
		expect(out.join("\n")).not.toContain("supabase_storage_admin");
		expect(out.join("\n")).not.toContain('TO "postgres"');
	});

	it("keeps custom roles without superuser-only attributes", () => {
		expect(out).toContain('CREATE ROLE "reporting";');
		expect(out).toContain(
			'ALTER ROLE "reporting" WITH INHERIT NOCREATEROLE NOCREATEDB LOGIN NOBYPASSRLS;',
		);
	});

	it("keeps allowed settings of reserved roles only", () => {
		expect(out).toContain(
			'ALTER ROLE "authenticator" SET "statement_timeout" TO \'8s\';',
		);
		expect(out.join("\n")).not.toContain('"search_path"');
	});

	it("folds repeated lines and resets the session", () => {
		expect(
			out.filter((line) => line === 'GRANT "pg_read_all_data" TO "reporting";'),
		).toHaveLength(1);
		expect(out.at(-2)).toBe("RESET ALL;");
	});
});

describe("schema dump transform (dump_schema.sh)", () => {
	const dump = [
		"\\restrict k",
		"SET transaction_timeout = 0;",
		'CREATE SCHEMA "app";',
		'CREATE TABLE "app"."todos" (',
		'    "id" bigint NOT NULL',
		");",
		'CREATE FUNCTION "app"."f"() RETURNS int LANGUAGE sql AS $$ select 1 $$;',
		'CREATE EVENT TRIGGER "issue_pg_cron_access" ON ddl_command_end',
		"         WHEN TAG IN ('CREATE EXTENSION')",
		'   EXECUTE FUNCTION "extensions"."grant_pg_cron_access"();',
		'CREATE EXTENSION IF NOT EXISTS "pgsodium" WITH SCHEMA "pgsodium";',
		"COMMENT ON EXTENSION \"pgsodium\" IS 'x';",
		'GRANT USAGE ON SCHEMA "auth" TO "anon";',
		'GRANT ALL ON TABLE "app"."todos" TO "anon";',
		'REVOKE ALL ON FUNCTION "pg_catalog"."now"() FROM "anon";',
		"CREATE PUBLICATION \"supabase_realtime\" WITH (publish = 'insert');",
		'ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "app" GRANT ALL ON TABLES TO "anon";',
	].join("\n");
	const out = transformSchemaDump(dump).split("\n");

	it("makes creates idempotent", () => {
		expect(out).toContain('CREATE SCHEMA IF NOT EXISTS "app";');
		expect(out).toContain('CREATE TABLE IF NOT EXISTS "app"."todos" (');
		expect(out.join("\n")).toContain('CREATE OR REPLACE FUNCTION "app"."f"()');
	});

	it("drops platform objects, meta-commands and pg17-only settings", () => {
		const text = out.join("\n");
		expect(text).not.toContain("\\restrict");
		expect(text).not.toContain("transaction_timeout");
		expect(text).not.toContain("EVENT TRIGGER");
		expect(text).not.toContain("WHEN TAG IN");
		expect(text).not.toContain("COMMENT ON EXTENSION");
		expect(text).not.toContain('ON SCHEMA "auth"');
		expect(text).not.toContain('"pg_catalog"."now"');
		expect(text).not.toContain("PUBLICATION");
		expect(text).not.toContain('FOR ROLE "supabase_admin"');
	});

	it("keeps grants on user objects and trims extension options", () => {
		expect(out).toContain('GRANT ALL ON TABLE "app"."todos" TO "anon";');
		expect(out).toContain('CREATE EXTENSION IF NOT EXISTS "pgsodium";');
	});
});

describe("dump arguments", () => {
	it("excludes internal schemas from the schema dump", () => {
		const args = dumpArgs("schema", "/dump/schema.sql");
		expect(args[0]).toBe("pg_dump");
		expect(args).toContain("--schema-only");
		for (const schema of SCHEMA_DUMP_EXCLUDED) {
			expect(args).toContain(schema);
		}
		expect(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2)).toEqual([
			"-f",
			"/dump/schema.sql",
		]);
	});

	it("keeps auth and storage data but not migration tables", () => {
		const args = dumpArgs("data", "/dump/data.sql");
		expect(args).toContain("--data-only");
		expect(DATA_DUMP_EXCLUDED).not.toContain("auth");
		expect(DATA_DUMP_EXCLUDED).not.toContain("storage");
		expect(args).toContain('"auth"."schema_migrations"');
		expect(args).toContain('"storage"."migrations"');
		expect(args).toContain('"storage"."buckets_vectors"');
		// Kept on purpose: it leaves extension config tables (cron.job) out
		// of the dump; cron jobs are copied through pg_cron (supabase-cron).
		expect(args.slice(-2)).toEqual(["--schema", "*"]);
	});

	it("dumps roles without passwords and vault rows on their own", () => {
		const roles = dumpArgs("roles", "/dump/roles.sql");
		expect(roles[0]).toBe("pg_dumpall");
		expect(roles).toContain("--no-role-passwords");
		const vault = dumpArgs("vault", "/dump/vault.sql");
		expect(vault).toContain('"vault"."secrets"');
		expect(vault).toContain("--data-only");
	});

	it("tells user schemas from platform ones (globs included)", () => {
		expect(isUserSchema("public")).toBe(true);
		expect(isUserSchema("app")).toBe(true);
		expect(isUserSchema("auth")).toBe(false);
		expect(isUserSchema("pg_toast")).toBe(false);
		expect(isUserSchema("_timescaledb_internal")).toBe(false);
		expect(isUserSchema("vault")).toBe(false);
	});
});
