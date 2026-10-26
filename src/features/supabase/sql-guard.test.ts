import { describe, expect, it } from "vitest";
import { analyzeSqlRisk, maskSql } from "./sql-guard";

const MANAGED = ["auth", "storage"];

describe("maskSql (what the audit log keeps of a statement)", () => {
	it("keeps the statement shape: verbs and identifiers stay readable", () => {
		expect(maskSql("drop schema auth cascade;")).toBe(
			"drop schema auth cascade;",
		);
		expect(maskSql('drop function public."My""Func"(int)')).toBe(
			'drop function public."My""Func"(int)',
		);
	});

	it("hides string literals, so a password in SQL never reaches the log", () => {
		const masked = maskSql("alter role app password 's3cret-value' login");
		expect(masked).toBe("alter role app password '…' login");
		expect(masked).not.toContain("s3cret");
	});

	it("hides doubled quotes and backslash escapes inside literals", () => {
		expect(maskSql("select 'it''s a secret', 2")).toBe("select '…', 2");
		expect(maskSql("select E'it\\'s a secret', 2")).toBe("select E'…', 2");
	});

	it("hides dollar-quoted bodies but keeps the function header", () => {
		expect(
			maskSql(
				"create function f() returns text language sql as $f$select 'x'$f$;",
			),
		).toBe("create function f() returns text language sql as $f$…$f$;");
		expect(maskSql("do $$ begin perform 1; end $$")).toBe("do $$…$$");
	});

	it("does not take a positional parameter for a dollar quote", () => {
		expect(maskSql("select $1 + $2")).toBe("select $1 + $2");
	});

	it("drops line and (nested) block comments", () => {
		expect(
			maskSql("select 1 -- password hunter2\n/* a /* nested */ b */ , 2"),
		).toBe("select 1 , 2");
	});

	it("masks an unterminated literal to the end instead of leaking it", () => {
		expect(maskSql("select 'abc def")).toBe("select '…'");
	});

	it("collapses whitespace so one statement is one line", () => {
		expect(maskSql("  drop   schema\n\tauth  cascade ;")).toBe(
			"drop schema auth cascade ;",
		);
	});
});

describe("analyzeSqlRisk (statements that need an explicit confirmation)", () => {
	it.each([
		["drop schema auth cascade", ["drop_schema"]],
		["DROP SCHEMA IF EXISTS h05 CASCADE;", ["drop_schema"]],
		["drop database app", ["drop_database"]],
		["alter role postgres with password 'x'", ["roles"]],
		["create role probe login", ["roles"]],
		["drop user probe", ["roles"]],
		["alter system set max_connections = 10", ["roles"]],
		["copy (select 1) to program 'id'", ["program"]],
		["COPY t FROM PROGRAM 'cat /etc/passwd'", ["program"]],
	])("flags %s", (sql, expected) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual(expected);
	});

	it.each([
		"create function auth.evil() returns int language sql as $$select 1$$",
		"create table storage.t(x int)",
		"drop function if exists auth.uid()",
		'DROP FUNCTION "auth"."uid"()',
		"create policy p on auth.users using (true)",
		"alter schema auth rename to old_auth",
	])("flags a change inside a managed schema: %s", (sql) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual(["managed_schema"]);
	});

	it("reports every risk of a multi-statement text once, in a fixed order", () => {
		expect(
			analyzeSqlRisk(
				"select 1; create role x; drop schema auth cascade; create role y; copy (select 1) to program 'id'",
				MANAGED,
			),
		).toEqual(["drop_schema", "roles", "program"]);
	});

	it.each([
		"create or replace function public.me() returns uuid language sql as $$select auth.uid()$$",
		"create policy p on public.notes using (auth.uid() = user_id)",
		"create table public.t (id uuid references auth.users(id))",
		"select * from auth.users",
		"insert into storage.buckets(id, name) values ('a', 'a')",
		"insert into auth.users(id, email) values (gen_random_uuid(), 'a@b.c')",
		"select 'drop schema auth cascade'",
		"-- drop schema auth\nselect 1",
		"create function f() returns int language sql as $$select 1$$",
		"",
		"   ",
	])("does not flag %j", (sql) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual([]);
	});

	it("flags nothing in a schema the template does not manage", () => {
		expect(analyzeSqlRisk("create table auth.x(i int)", [])).toEqual([]);
	});
});

describe("analyzeSqlRisk: privileges, session role, files, extensions", () => {
	it.each([
		["grant supabase_admin to anon", ["privileges"]],
		[
			"GRANT postgres, service_role TO authenticated WITH ADMIN OPTION",
			["privileges"],
		],
		["revoke authenticated from anon", ["privileges"]],
		["revoke admin option for x from y", ["privileges"]],
		["drop owned by anon cascade", ["privileges"]],
		["reassign owned by app to postgres", ["privileges"]],
		[
			"alter default privileges in schema public grant all on tables to anon",
			["privileges"],
		],
		["set role postgres", ["session_role"]],
		["SET LOCAL ROLE supabase_admin", ["session_role"]],
		["set session role service_role", ["session_role"]],
		["set session authorization postgres", ["session_role"]],
		["set local session authorization postgres", ["session_role"]],
		["select set_config('role', 'postgres', false)", ["session_role"]],
		["copy t from '/etc/passwd'", ["server_files"]],
		["copy (select 1) to '/tmp/out.csv' with (format csv)", ["server_files"]],
		["COPY t TO E'/tmp/x'", ["server_files"]],
		["select lo_import('/etc/passwd')", ["server_files"]],
		["select lo_export(16400, '/tmp/x')", ["server_files"]],
		["drop extension pgcrypto", ["extensions"]],
		["ALTER EXTENSION pg_net UPDATE", ["extensions"]],
		["drop extension if exists pg_graphql cascade", ["extensions"]],
	])("flags %s", (sql, expected) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual(expected);
	});

	it.each([
		"grant select on table public.notes to anon",
		"grant usage on schema public to authenticated",
		"revoke all on function public.f() from anon",
		"reset role",
		"copy t from stdin",
		"copy (select 1) to stdout with (format csv, delimiter ',')",
		"create extension if not exists pgcrypto",
		"select 'set role postgres'",
		"select 'lo_import(1)'",
	])("does not flag %j", (sql) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual([]);
	});
});

describe("analyzeSqlRisk: grants on managed schemas", () => {
	it.each([
		"grant select on auth.users to anon",
		"GRANT ALL PRIVILEGES ON TABLE auth.users, public.t TO authenticated",
		"grant select (email) on auth.users to anon",
		'grant execute on function "auth"."uid"() to anon',
		"revoke all on storage.objects from authenticated",
		"grant usage on schema auth to anon",
		"grant usage, create on schema public, storage to anon",
		"grant select on all tables in schema auth to anon",
		"REVOKE ALL ON ALL FUNCTIONS IN SCHEMA storage FROM public",
		'grant all on all sequences in schema "auth" to anon',
		"grant/**/select on auth . users to anon",
	])("flags %s", (sql) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual(["managed_schema"]);
	});

	it.each([
		"grant select on public.notes to anon",
		"grant select on notes to anon",
		"grant usage on schema public to authenticated",
		"grant select on all tables in schema public to anon",
		"revoke execute on function public.f(uuid) from anon",
		"grant select on public.t to anon -- not auth.users",
		"select 'grant select on auth.users to anon'",
	])("does not flag %j", (sql) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual([]);
	});

	it("flags nothing without managed schemas", () => {
		expect(analyzeSqlRisk("grant select on auth.users to anon", [])).toEqual(
			[],
		);
	});
});

describe("analyzeSqlRisk: rows and search_path in managed schemas", () => {
	it.each([
		"truncate auth.users",
		"TRUNCATE TABLE ONLY public.a, auth.users RESTART IDENTITY CASCADE",
		"delete from auth.users",
		"DELETE FROM ONLY storage.objects WHERE true",
		'update "auth"."users" set email = null',
		"with gone as (select 1) delete from auth.sessions",
		"merge into auth.users u using public.x on true when matched then delete",
	])("flags changing or deleting rows: %s", (sql) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual(["managed_data"]);
	});

	it.each([
		"select * from auth.users",
		"delete from public.notes where user_id = auth.uid()",
		"update public.t set x = 1 where id in (select id from auth.users)",
		"insert into public.t select * from auth.users",
		"insert into public.t(id) values (1) on conflict (id) do update set id = 1",
		"select * from public.t for update of t",
		"truncate public.notes",
	])("does not flag writing elsewhere: %j", (sql) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual([]);
	});

	it.each([
		"set search_path to auth",
		"SET search_path = public, auth",
		'set local search_path to "storage", public',
		"set search_path = 'auth'",
		"set session search_path to 'public, auth'",
		"set search_path = $$auth$$",
		"select set_config('search_path', 'auth,public', true)",
	])("flags a search_path at a managed schema: %s", (sql) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual(["search_path"]);
	});

	it.each([
		"set search_path to public, extensions",
		"set search_path = ''",
		"set search_path to '$user', public",
		"select set_config('search_path', 'public', true)",
	])("does not flag another search_path: %j", (sql) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual([]);
	});

	it("flags no rows or search_path without managed schemas", () => {
		expect(
			analyzeSqlRisk("truncate auth.users; set search_path to auth", []),
		).toEqual([]);
	});
});

describe("analyzeSqlRisk evasions (the text, not its tricks, decides)", () => {
	it.each([
		["drop/**/schema auth", ["drop_schema"]],
		["drop -- note\nschema auth", ["drop_schema"]],
		["DrOp ScHeMa auth", ["drop_schema"]],
		["/* a /* nested */ b */ grant supabase_admin to anon", ["privileges"]],
		["\n\tSET\n  ROLE\tpostgres", ["session_role"]],
		["truncate/**/auth . users", ["managed_data"]],
		// Quoted "AUTH" is another schema, but erring on the safe side is fine.
		['TRUNCATE "AUTH".users', ["managed_data"]],
		['truncate "auth" . "users"', ["managed_data"]],
		["select 1;set role postgres", ["session_role"]],
		["select 'x;y'; set role postgres", ["session_role"]],
		["select $q$ ; $q$; drop extension pgcrypto", ["extensions"]],
		[
			"copy t from 'a;b' ; truncate auth.users",
			["server_files", "managed_data"],
		],
	])("%j", (sql, expected) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual(expected);
	});

	it.each([
		"select 'grant supabase_admin to anon'",
		"select $$truncate auth.users$$",
		"-- set search_path to auth",
		"/* drop extension pgcrypto */ select 1",
		"select 'set search_path to auth'",
	])("a risk written inside a literal or comment is not run: %j", (sql) => {
		expect(analyzeSqlRisk(sql, MANAGED)).toEqual([]);
	});

	it("reports each risk once over many statements, in the registry order", () => {
		expect(
			analyzeSqlRisk(
				"set search_path to auth; truncate auth.users; set role postgres; grant a to b; drop schema x; truncate auth.sessions",
				MANAGED,
			),
		).toEqual([
			"drop_schema",
			"privileges",
			"session_role",
			"managed_data",
			"search_path",
		]);
	});
});
