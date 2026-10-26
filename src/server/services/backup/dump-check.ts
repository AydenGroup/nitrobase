import type { ErrorInfo } from "#/libs/coded.ts";
import { scanSql } from "#/server/services/databases/sql.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { coded } from "#/utils/error.ts";

/**
 * What a Nitrobase self-backup dump may contain (pure, line streaming).
 * The first-run restore runs before any account exists, so the dump is
 * untrusted input: on top of the database boundary (it is loaded as a
 * NOSUPERUSER role, see first-run-restore.server.ts), every statement must
 * look like what `pg_dump --no-owner --no-privileges` writes for the panel
 * schema:
 *
 * - statements are split with the console lexer (`scanSql`), so two
 *   statements on one line are two statements;
 * - each starts with an allowed form (SET of dump settings, the search_path
 *   set_config, setval, CREATE TYPE/TABLE/SEQUENCE/INDEX, ALTER
 *   TABLE/SEQUENCE);
 * - every `name(` outside literals is an allowed function (`now()`,
 *   `gen_random_uuid()`, `nextval()`, `lower()`, …), an SQL keyword that
 *   takes parentheses, or a relation after TABLE/REFERENCES;
 * - COPY only as `COPY t (cols) FROM stdin;` on its own line (its data,
 *   up to `\.`, is not SQL and is passed through);
 * - no backslash outside COPY data (psql runs meta-commands anywhere on a
 *   line) except the `\restrict`/`\unrestrict` lines newer pg_dump writes.
 */
export class DumpRefused extends Error {
	constructor(readonly reason: ErrorInfo) {
		super(reason.code ?? "dump refused");
		this.name = "DumpRefused";
	}
}

/** Settings pg_dump writes at the top of a plain dump. */
const DUMP_SETTINGS =
	"statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout|client_encoding|standard_conforming_strings|check_function_bodies|xmloption|client_min_messages|row_security|default_tablespace|default_table_access_method";

/**
 * The two function-call statements pg_dump writes, accepted only whole and
 * exactly: the search_path header and a sequence value. `set_config` and
 * `setval` are NOT callable anywhere else (`set_config('role', …)` in a
 * SELECT list or a DEFAULT could otherwise change the session's role).
 */
const EXACT_STATEMENTS = [
	/^SELECT pg_catalog\.set_config\('search_path', '', false\)$/,
	/^SELECT pg_catalog\.setval\('[A-Za-z_][\w."]*', \d{1,19}, (true|false)\)$/,
];

const ALLOWED_STATEMENTS = [
	new RegExp(`^SET\\s+(${DUMP_SETTINGS})\\s*=\\s*[\\w'"-]+$`, "i"),
	/^CREATE\s+TYPE\s+/i,
	/^CREATE\s+TABLE\s+/i,
	/^CREATE\s+SEQUENCE\s+/i,
	/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i,
	/^ALTER\s+TABLE\s+/i,
	/^ALTER\s+SEQUENCE\s+/i,
];

/** Functions a panel dump calls (defaults, index expressions, sequence values). */
const ALLOWED_FUNCTIONS = new Set([
	"now",
	"gen_random_uuid",
	"nextval",
	"lower",
]);

/** SQL words followed by `(` that are not function calls. */
const PAREN_KEYWORDS = new Set([
	"key",
	"unique",
	"enum",
	"btree",
	"where",
	"and",
	"or",
	"not",
	"in",
	"any",
	"check",
	"default",
	"include",
	"varying",
	"numeric",
	"timestamp",
	"time",
	"character",
	"interval",
]);

/** Words after which `name(` names a relation (CREATE TABLE t (…), REFERENCES t(id)). */
const RELATION_BEFORE = new Set(["table", "references"]);

const DENIED_WORDS =
	/\b(PROGRAM|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|dblink\w*|query_to_xml\w*|pg_execute_server_program|pg_terminate_backend|pg_cancel_backend|pg_reload_conf)\b/i;

const COPY_FROM_STDIN =
	/^COPY\s+[A-Za-z_][\w.]*\s*(\([\w\s,"]*\))?\s+FROM\s+stdin;$/i;

/** psql meta-commands newer pg_dump versions write (restrict mode). */
const ALLOWED_META = /^\\(restrict|unrestrict)\s+[A-Za-z0-9]+$/;

/** Schemas the restore creates itself (their CREATE SCHEMA is dropped). */
const OWN_SCHEMAS = /^CREATE\s+SCHEMA\s+(public|drizzle);$/i;

/** Statement text with literals and quoted identifiers blanked. */
function masked(text: string): string {
	const { literals } = scanSql(text, "postgres");
	let out = "";
	let at = 0;
	for (const [start, end] of literals) {
		out += `${text.slice(at, start)}''`;
		at = end;
	}
	out += text.slice(at);
	return out.replace(/"(?:[^"]|"")*"/g, '"q"');
}

/** Why a single statement is not allowed, or null. */
export function checkStatement(text: string): ErrorInfo | null {
	if (/^COPY\s/i.test(text)) return coded("DUMP_COPY_FORM");
	if (EXACT_STATEMENTS.some((pattern) => pattern.test(text))) return null;
	if (!ALLOWED_STATEMENTS.some((pattern) => pattern.test(text))) {
		return coded("DUMP_STATEMENT_DENIED", {
			text: text.split(/\s+/).slice(0, 3).join(" "),
		});
	}
	const code = masked(text);
	const denied = DENIED_WORDS.exec(code);
	if (denied) return coded("DUMP_STATEMENT_DENIED", { text: denied[1] });
	const call =
		/([A-Za-z_][\w$]*(?:\s*\.\s*(?:[A-Za-z_][\w$]*|"q"))*|"q")\s*\(/g;
	for (const match of code.matchAll(call)) {
		const name = (match[1].split(".").pop() ?? "").trim().toLowerCase();
		if (ALLOWED_FUNCTIONS.has(name) || PAREN_KEYWORDS.has(name)) continue;
		const before = /([A-Za-z_]+)\s*$/.exec(code.slice(0, match.index));
		if (before && RELATION_BEFORE.has(before[1].toLowerCase())) continue;
		return coded("DUMP_STATEMENT_DENIED", { text: `${name}(` });
	}
	return null;
}

/**
 * Line filter: feed every line of the dump; it returns the line to load
 * (null: dropped) or throws DumpRefused. Call `end()` after the last line.
 */
export class DumpScriptFilter {
	private buffer = "";
	private inCopy = false;
	private lineNo = 0;

	constructor(private readonly maxStatementBytes: number) {}

	private refuse(reason: ErrorInfo): never {
		throw new DumpRefused(
			coded("DUMP_LINE", { line: this.lineNo, reason: { $error: reason } }),
		);
	}

	line(raw: string): string | null {
		this.lineNo++;
		const line = raw.replace(/\r$/, "");
		if (line.includes("\0")) this.refuse(coded("DUMP_NUL"));
		if (this.inCopy) {
			if (line === "\\.") this.inCopy = false;
			return line;
		}
		const trimmed = line.trim();
		if (!this.buffer) {
			if (trimmed === "" || trimmed.startsWith("--")) return line;
			if (trimmed.startsWith("\\")) {
				if (!ALLOWED_META.test(trimmed))
					this.refuse(coded("DUMP_PSQL_COMMAND"));
				return line;
			}
			if (OWN_SCHEMAS.test(trimmed)) return null;
			if (COPY_FROM_STDIN.test(trimmed)) {
				this.inCopy = true;
				return line;
			}
		}
		if (line.includes("\\")) this.refuse(coded("DUMP_BACKSLASH"));
		this.buffer = this.buffer ? `${this.buffer}\n${line}` : line;
		if (this.buffer.length > this.maxStatementBytes) {
			this.refuse(coded("DUMP_STATEMENT_TOO_LONG"));
		}
		if (trimmed.endsWith(";")) this.flush(false);
		return line;
	}

	/** Check the buffered statements once they are complete. */
	private flush(final: boolean): void {
		let statements: ReturnType<typeof scanSql>["statements"];
		try {
			({ statements } = scanSql(this.buffer, "postgres"));
		} catch (error) {
			// A `;` inside an open string or comment: the statement goes on.
			if (!final && error instanceof TemplateError) return;
			this.refuse(coded("DUMP_UNTERMINATED"));
		}
		if (!/;\s*$/.test(this.buffer)) this.refuse(coded("DUMP_UNTERMINATED"));
		for (const statement of statements) {
			const problem = checkStatement(statement.text);
			if (problem) this.refuse(problem);
		}
		this.buffer = "";
	}

	end(): void {
		if (this.inCopy) this.refuse(coded("DUMP_UNTERMINATED_COPY"));
		if (this.buffer.trim()) this.flush(true);
	}
}

/**
 * Superuser step before the load: empty the database and recreate its
 * schemas owned by the restore role (the dump itself runs logged in AS
 * that role, see first-run-restore.server.ts).
 */
export function restorePreamble(roleIdent: string): string {
	return [
		"DROP SCHEMA IF EXISTS drizzle CASCADE;",
		"DROP SCHEMA public CASCADE;",
		`CREATE SCHEMA public AUTHORIZATION ${roleIdent};`,
		`CREATE SCHEMA drizzle AUTHORIZATION ${roleIdent};`,
	].join("\n");
}

/** Superuser step after the load: everything back to the panel's login. */
export function restorePostamble(roleIdent: string): string {
	return `REASSIGN OWNED BY ${roleIdent} TO CURRENT_USER;`;
}
