import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SELF_BACKUP_LAYOUT,
	type SelfBackupLayout,
} from "#/config/self-backup.ts";
import { APP_ID } from "#/config/shared.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { buildTar } from "#/server/services/supabase/edge-functions.ts";
import {
	checkStatement,
	DumpRefused,
	DumpScriptFilter,
	restorePostamble,
	restorePreamble,
} from "./dump-check";
import { opensslEncrypt } from "./openssl";
import {
	PanelArchiveError,
	readPanelArchive,
	receiveToFile,
	writeRestoreScript,
} from "./panel-archive";

const sha256Hex = (data: Buffer) =>
	createHash("sha256").update(data).digest("hex");

/** The whole text through the restore's filter: null when allowed. */
function checkDumpScript(sql: string): ErrorInfo | null {
	const filter = new DumpScriptFilter(1 << 20);
	try {
		for (const line of sql.split("\n")) filter.line(line);
		filter.end();
		return null;
	} catch (error) {
		if (error instanceof DumpRefused) return error.reason;
		throw error;
	}
}

const KEY = "k".repeat(40);
const ITER = 1000;
/** `pg_dump --no-owner --no-privileges` of the migrated panel schema (PG 16). */
const REAL_DUMP = readFileSync(
	path.join(__dirname, "__fixtures__/panel-dump.sql"),
	"utf8",
);

/** A dump with data (trimmed). */
const DUMP = [
	"--",
	"-- PostgreSQL database dump",
	"--",
	"\\restrict 3fVq9kQeZ",
	"SET statement_timeout = 0;",
	"SET client_encoding = 'UTF8';",
	"SELECT pg_catalog.set_config('search_path', '', false);",
	"CREATE SCHEMA drizzle;",
	"CREATE TABLE public.users (",
	"    id uuid DEFAULT gen_random_uuid() NOT NULL,",
	"    email text NOT NULL,",
	"    created_at timestamp without time zone DEFAULT now() NOT NULL",
	");",
	"COPY public.users (id, email, created_at) FROM stdin;",
	"0b9b1c2e-0000-4000-8000-000000000001\tadmin@example.com\t2026-10-01 10:00:00",
	"0b9b1c2e-0000-4000-8000-000000000002\twith\\\\backslash; DROP TABLE x; \\! id\t2026-10-01 10:00:00",
	"\\.",
	"ALTER TABLE ONLY public.users",
	"    ADD CONSTRAINT users_pkey PRIMARY KEY (id);",
	"CREATE UNIQUE INDEX users_email_lower_idx ON public.users USING btree (lower(email));",
	"\\unrestrict 3fVq9kQeZ",
	"",
].join("\n");

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "sb-archive-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function archive(
	options: {
		dump?: string;
		manifest?: Record<string, unknown>;
		key?: string;
		layout?: SelfBackupLayout;
		/** Dump member name inside the root, when it differs from the layout's. */
		dumpName?: string;
	} = {},
): Buffer {
	const layout = options.layout ?? SELF_BACKUP_LAYOUT;
	const dumpName = options.dumpName ?? layout.dump;
	const dump = Buffer.from(options.dump ?? DUMP);
	const manifest = options.manifest ?? {
		format: 1,
		kind: "panel",
		createdAt: "2026-10-01T10:00:00.000Z",
		version: "0.1.0",
		members: [{ path: dumpName, sha256: sha256Hex(dump), size: dump.length }],
	};
	return opensslEncrypt(
		gzipSync(
			buildTar(layout.root, [
				{ path: "manifest.json", content: JSON.stringify(manifest) },
				{ path: dumpName, content: dump },
			]),
		),
		options.key ?? KEY,
		ITER,
	);
}

async function* chunks(data: Buffer, size = 1000) {
	for (let at = 0; at < data.length; at += size) {
		yield new Uint8Array(data.subarray(at, at + size));
	}
}

async function read(
	data: Buffer,
	overrides: { key?: string; expected?: string; maxBytes?: number } = {},
) {
	const file = path.join(dir, "upload.enc");
	const { sha256 } = await receiveToFile(chunks(data, 777), file, 1 << 24);
	const dumpPath = path.join(dir, "dump.sql");
	const { manifest } = await readPanelArchive({
		file,
		sha256,
		expectedSha256: overrides.expected ?? sha256Hex(data),
		key: overrides.key ?? KEY,
		iterations: ITER,
		maxBytes: overrides.maxBytes ?? 1 << 24,
		dumpPath,
	});
	return { manifest, dump: readFileSync(dumpPath, "utf8") };
}

async function problem(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
		return "ok";
	} catch (error) {
		return error instanceof PanelArchiveError
			? error.problem.code
			: String(error);
	}
}

describe("self-backup archive (streamed to disk)", () => {
	it("reads a genuine archive in chunks", async () => {
		const data = archive();
		const { manifest, dump } = await read(data, {
			expected: ` ${sha256Hex(data).toUpperCase()} `,
		});
		expect(manifest.version).toBe("0.1.0");
		expect(dump).toBe(DUMP);
	});

	it("writes the current product id in member names", () => {
		expect(SELF_BACKUP_LAYOUT).toEqual({
			root: `${APP_ID}-backup`,
			dump: `${APP_ID}.sql`,
		});
	});

	it("reads archives with the current names", async () => {
		const { manifest } = await read(archive());
		expect(manifest.members[0]?.path).toBe(`${APP_ID}.sql`);
	});

	it("refuses archives of another layout", async () => {
		const data = archive({
			layout: { root: "other-backup", dump: "other.sql" },
		});
		expect(await problem(() => read(data))).toBe("archive");
		expect(await problem(() => read(archive({ dumpName: "other.sql" })))).toBe(
			"archive",
		);
	});

	it("caps the upload, chunked bodies included", async () => {
		expect(
			await problem(() =>
				receiveToFile(chunks(Buffer.alloc(5000)), path.join(dir, "x"), 4096),
			),
		).toBe("too_large");
	});

	it("checks the noted sha256 before decrypting", async () => {
		const data = archive();
		expect(await problem(() => read(data, { expected: "0".repeat(64) }))).toBe(
			"checksum",
		);
		const tampered = Buffer.from(data);
		tampered[tampered.length - 20] ^= 1;
		expect(
			await problem(() => read(tampered, { expected: sha256Hex(data) })),
		).toBe("checksum");
	});

	it("needs the old ENCRYPTION_KEY", async () => {
		expect(await problem(() => read(archive(), { key: "x".repeat(40) }))).toBe(
			"decrypt",
		);
	});

	it("stops decompression bombs", async () => {
		const big = "x".repeat(200_000);
		expect(
			await problem(() =>
				read(archive({ dump: `${DUMP}--${big}\n` }), { maxBytes: 50_000 }),
			),
		).toBe("too_large");
	});

	it("refuses archives that are not panel self-backups", async () => {
		expect(
			await problem(() =>
				read(archive({ manifest: { format: 1, kind: "app", members: [] } })),
			),
		).toBe("archive");
		expect(
			await problem(() =>
				read(
					archive({
						manifest: {
							format: 1,
							kind: "panel",
							members: [
								{
									path: SELF_BACKUP_LAYOUT.dump,
									sha256: "0".repeat(64),
									size: 1,
								},
							],
						},
					}),
				),
			),
		).toBe("archive");
		const notTar = opensslEncrypt(gzipSync(Buffer.from("hello")), KEY, ITER);
		expect(await problem(() => read(notTar))).toBe("archive");
	});
});

describe("dump check", () => {
	it("accepts a real pg_dump of the panel schema and the data form", () => {
		expect(checkDumpScript(REAL_DUMP)).toBeNull();
		expect(checkDumpScript(DUMP)).toBeNull();
	});

	it("splits two statements on one line (reviewer bypass 1)", () => {
		expect(
			checkDumpScript(
				`${DUMP}\nSET client_min_messages = warning; ALTER SYSTEM SET archive_command = 'x';\n`,
			),
		).toMatchObject({
			code: "DUMP_LINE",
			params: {
				reason: {
					$error: {
						code: "DUMP_STATEMENT_DENIED",
						params: { text: "ALTER SYSTEM SET" },
					},
				},
			},
		});
		expect(
			checkDumpScript(
				`${DUMP}\nSET row_security = off; COPY public.users TO PROGRAM 'id';\n`,
			),
		).not.toBeNull();
	});

	it("refuses function calls outside the allowlist (reviewer bypass 2)", () => {
		const payload = Buffer.from("select pg_read_file('/etc/passwd')").toString(
			"base64",
		);
		expect(
			checkDumpScript(
				`${DUMP}\nCREATE TABLE public.t (a xml DEFAULT query_to_xml(convert_from(decode('${payload}', 'base64'), 'UTF8'), true, false, ''));\n`,
			),
		).not.toBeNull();
		expect(
			checkStatement(
				"CREATE TABLE public.t (a text DEFAULT convert_from(decode('x', 'base64'), 'UTF8'))",
			),
		).toMatchObject({
			code: "DUMP_STATEMENT_DENIED",
			params: { text: "convert_from(" },
		});
		// Parentheses inside literals are not calls.
		expect(
			checkStatement("CREATE TABLE public.t (a text DEFAULT 'f(x)'::text)"),
		).toBeNull();
	});

	it.each([
		["COPY FROM PROGRAM", "COPY public.users (id) FROM PROGRAM 'id';"],
		["COPY split over lines", "COPY public.users (id)\nFROM stdin;"],
		[
			"a function",
			"CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'select 1';",
		],
		["a DO block", "DO $$ BEGIN PERFORM 1; END $$;"],
		["a role", "CREATE ROLE evil SUPERUSER;"],
		["SET ROLE", "SET ROLE nitrobase;"],
		["RESET ROLE", "RESET ROLE;"],
		["another schema", "CREATE SCHEMA evil;"],
		["an extension", "CREATE EXTENSION dblink;"],
		["a shell escape", "\\! id"],
		["a backslash mid-line", "CREATE TABLE public.t (a int); \\! id"],
		["a GUC outside the dump list", "SET session_preload_libraries = 'x';"],
		[
			"another set_config",
			"SELECT pg_catalog.set_config('log_statement', 'all', false);",
		],
		[
			"setval smuggling a call",
			"SELECT pg_catalog.setval('s', 1, true), pg_sleep(10);",
		],
		[
			"a default calling pg_read_file",
			"CREATE TABLE public.t (a text DEFAULT pg_read_file('/etc/passwd'));",
		],
	])("refuses %s", (_, statement) => {
		expect(checkDumpScript(`${DUMP}\n${statement}\n`)).not.toBeNull();
	});

	it("refuses unterminated COPY data or statements", () => {
		const reason = (sql: string) =>
			(checkDumpScript(sql)?.params?.reason as { $error: { code: string } })
				?.$error.code;
		expect(reason("COPY public.users (id) FROM stdin;\n1\n")).toBe(
			"DUMP_UNTERMINATED_COPY",
		);
		expect(reason("CREATE TABLE public.t (\n a int\n")).toBe(
			"DUMP_UNTERMINATED",
		);
		expect(reason("CREATE TABLE public.t (a text DEFAULT 'x;\n")).toBe(
			"DUMP_UNTERMINATED",
		);
	});

	it("writes the load script (checked dump only) and the superuser steps", async () => {
		const dumpPath = path.join(dir, "d.sql");
		const scriptPath = path.join(dir, "s.sql");
		writeFileSync(dumpPath, DUMP);
		const opts = {
			dumpPath,
			scriptPath,
			preamble: "",
			postamble: "",
			maxStatementBytes: 1 << 20,
		};
		await writeRestoreScript(opts);
		const script = readFileSync(scriptPath, "utf8");
		// The dump's own CREATE SCHEMA is dropped (the superuser step creates it).
		expect(script.match(/^CREATE SCHEMA drizzle;$/gm)).toBeNull();
		expect(script).toContain("COPY public.users");
		const role = '"nitrobase_restore"';
		expect(restorePreamble(role).split("\n")).toEqual([
			"DROP SCHEMA IF EXISTS drizzle CASCADE;",
			"DROP SCHEMA public CASCADE;",
			`CREATE SCHEMA public AUTHORIZATION ${role};`,
			`CREATE SCHEMA drizzle AUTHORIZATION ${role};`,
		]);
		expect(restorePostamble(role)).toBe(
			`REASSIGN OWNED BY ${role} TO CURRENT_USER;`,
		);
		writeFileSync(dumpPath, `${DUMP}\nRESET ROLE;\n`);
		expect(await problem(() => writeRestoreScript(opts))).toBe("dump");
	});
});
