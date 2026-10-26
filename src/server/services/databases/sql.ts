import { TemplateError } from "#/server/services/templates/naming.ts";

/**
 * SQL text handling of the database console (pure, tested): a lexer that
 * splits statements the way psql / the mysql client do (strings, quoted
 * identifiers, dollar quotes, comments), the read-only rules, and the
 * identifier/literal quoting used by users-and-databases management.
 *
 * The lexer is a guard rail, not the security boundary: read-only runs log
 * in as a role that can only read (see CONSOLE_ROLE) inside a READ ONLY
 * transaction, so a statement the lexer misjudges still cannot write.
 */

export type SqlDialect = "postgres" | "mysql";

export interface SqlStatement {
	/** Statement text without the trailing `;`. */
	text: string;
	/** First words (upper case, comments skipped), e.g. ["SELECT"]. */
	words: string[];
}

export interface ScannedSql {
	statements: SqlStatement[];
	/** A backslash outside strings/comments (psql or mysql client command). */
	backslash: boolean;
	/**
	 * A MySQL/MariaDB executable comment (`/*! … *\/`, MariaDB `/*M! … *\/`),
	 * run by the server.
	 */
	executableComment: boolean;
	/** String literals (incl. dollar quotes): `[start, end)` offsets. */
	literals: [number, number][];
}

/**
 * Codes of console refusals (error catalog keys, `#/libs/error-codes.ts`):
 * the UI shows a translated reason instead of the English message.
 */
export type ConsoleRefusalCode =
	| "DATABASE_QUERY_READ_ONLY"
	| "DATABASE_QUERY_BACKSLASH"
	| "DATABASE_QUERY_CLIENT_COMMAND"
	| "DATABASE_QUERY_EXECUTABLE_COMMENT"
	| "DATABASE_COMMAND_DENIED"
	| "DATABASE_COMMAND_READ_ONLY";

/** A console input refused by a rule (coded, rendered in the reader's language). */
export class ConsoleRefusal extends TemplateError<ConsoleRefusalCode> {
	constructor(code: ConsoleRefusalCode, command?: string) {
		super(code, { command: command ?? "" } as never);
		this.name = "ConsoleRefusal";
	}
}

const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;

/** Split SQL into statements, tracking what the console rules need. */
export function scanSql(sql: string, dialect: SqlDialect): ScannedSql {
	const statements: SqlStatement[] = [];
	const literals: [number, number][] = [];
	let backslash = false;
	let executableComment = false;
	let start = 0;
	let words: string[] = [];
	let i = 0;
	const n = sql.length;
	const finish = (end: number) => {
		const text = sql.slice(start, end).trim();
		if (text) statements.push({ text, words });
		words = [];
		start = end + 1;
	};
	const unterminated = (
		code:
			| "SQL_UNTERMINATED_COMMENT"
			| "SQL_UNTERMINATED_QUOTE"
			| "SQL_UNTERMINATED_DOLLAR_QUOTE",
	) => {
		throw new TemplateError(code);
	};
	while (i < n) {
		const c = sql[i];
		const next = sql[i + 1];
		// Comments.
		if (
			c === "-" &&
			next === "-" &&
			(dialect === "postgres" || /[\s]/.test(sql[i + 2] ?? " "))
		) {
			const end = sql.indexOf("\n", i);
			i = end === -1 ? n : end + 1;
			continue;
		}
		if (dialect === "mysql" && c === "#") {
			const end = sql.indexOf("\n", i);
			i = end === -1 ? n : end + 1;
			continue;
		}
		if (c === "/" && next === "*") {
			if (
				dialect === "mysql" &&
				(sql[i + 2] === "!" || (sql[i + 2] === "M" && sql[i + 3] === "!"))
			) {
				executableComment = true;
			}
			if (dialect === "postgres") {
				// Postgres block comments nest.
				let depth = 1;
				let j = i + 2;
				while (j < n && depth > 0) {
					if (sql[j] === "/" && sql[j + 1] === "*") {
						depth++;
						j += 2;
					} else if (sql[j] === "*" && sql[j + 1] === "/") {
						depth--;
						j += 2;
					} else j++;
				}
				if (depth > 0) unterminated("SQL_UNTERMINATED_COMMENT");
				i = j;
			} else {
				const end = sql.indexOf("*/", i + 2);
				if (end === -1) unterminated("SQL_UNTERMINATED_COMMENT");
				i = end + 2;
			}
			continue;
		}
		// Strings and quoted identifiers.
		if (c === "'" || c === '"' || (dialect === "mysql" && c === "`")) {
			// Postgres E'…' strings and MySQL strings use backslash escapes.
			const prev = sql[i - 1];
			const escapes =
				c !== "`" &&
				(dialect === "mysql" ||
					(c === "'" &&
						(prev === "E" || prev === "e") &&
						!/[A-Za-z0-9_$]/.test(sql[i - 2] ?? "")));
			let j = i + 1;
			for (;;) {
				if (j >= n) unterminated("SQL_UNTERMINATED_QUOTE");
				const d = sql[j];
				if (escapes && d === "\\") {
					j += 2;
					continue;
				}
				if (d === c) {
					if (sql[j + 1] === c) {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			if (c === "'" || (c === '"' && dialect === "mysql")) {
				literals.push([i, j + 1]);
			} else if (words.length < 4) {
				words.push(quotedWord(sql, i, j));
			}
			i = j + 1;
			continue;
		}
		// Postgres dollar quotes: $$…$$ or $tag$…$tag$.
		if (dialect === "postgres" && c === "$") {
			const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 66));
			if (match && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
				const tag = match[0];
				const end = sql.indexOf(tag, i + tag.length);
				if (end === -1) unterminated("SQL_UNTERMINATED_DOLLAR_QUOTE");
				literals.push([i, end + tag.length]);
				i = end + tag.length;
				continue;
			}
		}
		if (c === "\\") {
			backslash = true;
			i++;
			continue;
		}
		if (c === ";") {
			finish(i);
			i++;
			continue;
		}
		WORD.lastIndex = i;
		const word = WORD.exec(sql);
		if (word && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "")) {
			if (words.length < 4) words.push(word[0].toUpperCase());
			i += word[0].length;
			continue;
		}
		i++;
	}
	finish(n);
	return { statements, backslash, executableComment, literals };
}

/**
 * SQL for the audit log: every string literal and dollar-quoted body
 * replaced by `'…'` (passwords in CREATE USER / ALTER ROLE…). Text the
 * lexer can't read is masked from the first quote on.
 */
export function maskSqlLiterals(sql: string, dialect: SqlDialect): string {
	let literals: [number, number][];
	try {
		literals = scanSql(sql, dialect).literals;
	} catch {
		const first = sql.search(/['"$]/);
		return first === -1 ? sql : `${sql.slice(0, first)}'…'`;
	}
	let out = "";
	let at = 0;
	for (const [from, to] of literals) {
		out += `${sql.slice(at, from)}'…'`;
		at = to;
	}
	return out + sql.slice(at);
}

/** A quoted identifier as a word (`"Order"` → ORDER is wrong: keep as is). */
function quotedWord(sql: string, from: number, to: number): string {
	return sql.slice(from, to + 1);
}

/**
 * Postgres statements a read-only run refuses: transaction control (the
 * run is one READ ONLY transaction; ending it would leave the rest
 * outside) and changes of the read-only setting.
 */
const PG_READ_ONLY_DENIED = new Set([
	"BEGIN",
	"START",
	"COMMIT",
	"END",
	"ROLLBACK",
	"ABORT",
	"SAVEPOINT",
	"RELEASE",
	"PREPARE",
]);

/** MySQL/MariaDB statements a read-only run allows (first word). */
const MYSQL_READ_ONLY_ALLOWED = new Set([
	"SELECT",
	"SHOW",
	"DESCRIBE",
	"DESC",
	"EXPLAIN",
	"WITH",
	"TABLE",
	"VALUES",
	"USE",
]);

/** mysql client commands (recognised at the start of a statement). */
const MYSQL_CLIENT_COMMANDS = new Set([
	"?",
	"CHARSET",
	"CLEAR",
	"CONNECT",
	"DELIMITER",
	"EDIT",
	"EGO",
	"EXIT",
	"GO",
	"HELP",
	"NOPAGER",
	"NOTEE",
	"NOWARNING",
	"PAGER",
	"PRINT",
	"PROMPT",
	"QUIT",
	"QUERY_ATTRIBUTES",
	"REHASH",
	"RESETCONNECTION",
	"SOURCE",
	"SSL_SESSION_DATA_PRINT",
	"STATUS",
	"SYSTEM",
	"TEE",
	"WARNINGS",
]);

const READ_ONLY_SETTINGS = /^(DEFAULT_)?TRANSACTION_READ_ONLY$|^TX_READ_ONLY$/;

export interface ConsoleSqlCheck {
	statements: SqlStatement[];
}

/**
 * Validate console SQL: not empty, size-limited, no client/meta commands;
 * in read-only mode only reading statements (see the sets above). Throws a
 * TemplateError with an English reason (shown inline).
 */
export function checkConsoleSql(
	sql: string,
	dialect: SqlDialect,
	options: { readOnly: boolean; maxBytes: number },
): ConsoleSqlCheck {
	if (sql.includes("\0")) throw new TemplateError("SQL_NUL");
	if (Buffer.byteLength(sql, "utf8") > options.maxBytes) {
		throw new TemplateError("SQL_TOO_LARGE", {
			max: { $bytes: options.maxBytes },
		});
	}
	const scanned = scanSql(sql, dialect);
	if (scanned.statements.length === 0) throw new TemplateError("SQL_EMPTY");
	if (scanned.backslash) {
		throw new ConsoleRefusal("DATABASE_QUERY_BACKSLASH");
	}
	for (const statement of scanned.statements) {
		const [first = "", second = "", third = ""] = statement.words;
		if (dialect === "mysql" && MYSQL_CLIENT_COMMANDS.has(first)) {
			throw new ConsoleRefusal(
				"DATABASE_QUERY_CLIENT_COMMAND",
				first.toLowerCase(),
			);
		}
		if (!options.readOnly) continue;
		if (dialect === "postgres") {
			if (PG_READ_ONLY_DENIED.has(first)) {
				throw new ConsoleRefusal("DATABASE_QUERY_READ_ONLY", first);
			}
			if (
				(first === "SET" || first === "RESET") &&
				(second === "TRANSACTION" ||
					(second === "SESSION" && third === "CHARACTERISTICS") ||
					READ_ONLY_SETTINGS.test(second) ||
					READ_ONLY_SETTINGS.test(third) ||
					second === "ROLE" ||
					(second === "SESSION" && third === "AUTHORIZATION"))
			) {
				throw new ConsoleRefusal(
					"DATABASE_QUERY_READ_ONLY",
					`${first} ${second}`,
				);
			}
		} else {
			if (scanned.executableComment) {
				throw new ConsoleRefusal("DATABASE_QUERY_EXECUTABLE_COMMENT");
			}
			if (!MYSQL_READ_ONLY_ALLOWED.has(first)) {
				throw new ConsoleRefusal("DATABASE_QUERY_READ_ONLY", first || "?");
			}
			if (
				statement.text.toUpperCase().match(/\b(OUTFILE|DUMPFILE)\b/) &&
				/\bINTO\b/i.test(statement.text)
			) {
				throw new ConsoleRefusal("DATABASE_QUERY_READ_ONLY", "INTO OUTFILE");
			}
		}
	}
	return { statements: scanned.statements };
}

// ---------------------------------------------------------------------------
// Quoting (identifiers are always quoted, even when validated).

/** Postgres identifier, like `format('%I')` / `quote_ident` (always quoted). */
export function pgIdent(value: string): string {
	if (!value || value.includes("\0")) {
		throw new TemplateError("SQL_IDENTIFIER_INVALID");
	}
	return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Postgres string literal, like `format('%L')`: `E''` form so it is right
 * whatever `standard_conforming_strings` is.
 */
export function pgLiteral(value: string): string {
	if (value.includes("\0")) throw new TemplateError("SQL_LITERAL_INVALID");
	return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** MySQL identifier in backticks (backticks doubled). */
export function mysqlIdent(value: string): string {
	if (!value || value.includes("\0")) {
		throw new TemplateError("SQL_IDENTIFIER_INVALID");
	}
	return `\`${value.replace(/`/g, "``")}\``;
}

/**
 * MySQL string literal. Quotes are doubled; backslashes are refused (their
 * meaning depends on NO_BACKSLASH_ESCAPES, so no escaping is right in both
 * modes).
 */
export function mysqlLiteral(value: string): string {
	if (value.includes("\0") || value.includes("\\")) {
		throw new TemplateError("SQL_LITERAL_INVALID");
	}
	return `'${value.replace(/'/g, "''")}'`;
}
