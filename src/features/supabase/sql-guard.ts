/**
 * Helpers for the SQL typed into the Database Functions tab. Pure (no
 * server imports): the tab uses them to ask for confirmation, the server to
 * enforce it and to write the audit log.
 */

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;
/** What replaces a masked string literal or dollar-quoted body. */
const MASK = "…";

/**
 * A statement as the audit log keeps it: comments dropped, string literals
 * and dollar-quoted bodies hidden (values such as `PASSWORD 's3cret'` never
 * reach the log), identifiers and keywords kept, whitespace collapsed. An
 * unterminated literal is hidden to the end of the text.
 */
export function maskSql(sql: string): string {
	return scanSql(sql, "mask");
}

/**
 * The words of a literal (letters, digits, `_`, `$`, commas, spaces), for
 * values that name schemas (`set search_path = 'auth'`). Never `;` or a
 * quote, so statements split the same as the masked text.
 */
function literalWords(content: string): string {
	return content.replace(/[^A-Za-z0-9_$,\s]/g, " ");
}

/**
 * `maskSql` (`literals: "mask"`), or the same text with each literal and
 * dollar-quoted body reduced to its words (`"words"`, for the risk checks
 * that read a value). Both split into the same statements on `;`.
 */
function scanSql(sql: string, literals: "mask" | "words"): string {
	let out = "";
	let i = 0;
	const n = sql.length;
	while (i < n) {
		const c = sql[i];
		const next = sql[i + 1];
		// -- line comment
		if (c === "-" && next === "-") {
			const end = sql.indexOf("\n", i);
			i = end === -1 ? n : end;
			out += " ";
			continue;
		}
		// /* block comment */ (Postgres nests them)
		if (c === "/" && next === "*") {
			let depth = 1;
			i += 2;
			while (i < n && depth > 0) {
				if (sql[i] === "/" && sql[i + 1] === "*") {
					depth += 1;
					i += 2;
				} else if (sql[i] === "*" && sql[i + 1] === "/") {
					depth -= 1;
					i += 2;
				} else i += 1;
			}
			out += " ";
			continue;
		}
		// $tag$ ... $tag$ (a positional parameter like $1 has no closing $)
		if (c === "$") {
			const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))?.[0];
			if (tag) {
				const end = sql.indexOf(tag, i + tag.length);
				out +=
					literals === "mask"
						? `${tag}${MASK}${tag}`
						: `'${literalWords(sql.slice(i + tag.length, end === -1 ? n : end))}'`;
				i = end === -1 ? n : end + tag.length;
				continue;
			}
		}
		// 'string' (also E'string', where a backslash escapes the next char)
		if (c === "'") {
			const prev = sql[i - 1];
			const escapes =
				(prev === "E" || prev === "e") && !IDENT_CHAR.test(sql[i - 2] ?? " ");
			let j = i + 1;
			while (j < n) {
				if (escapes && sql[j] === "\\") j += 2;
				else if (sql[j] === "'") {
					if (sql[j + 1] === "'") j += 2;
					else break;
				} else j += 1;
			}
			out +=
				literals === "mask"
					? `'${MASK}'`
					: `'${literalWords(sql.slice(i + 1, Math.min(j, n)))}'`;
			i = j + 1;
			continue;
		}
		// "identifier" stays as written (a doubled quote is an escaped quote)
		if (c === '"') {
			let j = i + 1;
			while (j < n) {
				if (sql[j] === '"') {
					if (sql[j + 1] === '"') j += 2;
					else break;
				} else j += 1;
			}
			out += sql.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		out += c;
		i += 1;
	}
	return out.replace(/\s+/g, " ").trim();
}

/**
 * Kinds of statement the tab asks the user to confirm (labels:
 * `#/config/sql-risks.ts`). Fixed order: the result of `analyzeSqlRisk`
 * and the refusal follow it.
 */
const SQL_RISKS = [
	"drop_schema",
	"drop_database",
	"roles",
	"privileges",
	"session_role",
	"program",
	"server_files",
	"extensions",
	"managed_schema",
	"managed_data",
	"search_path",
] as const;
export type SqlRisk = (typeof SQL_RISKS)[number];

/** A schema-qualified name: group 1 is the schema. */
const QUALIFIED = /"?([a-z_][a-z0-9_$]*)"?\s*\.\s*"?[a-z_]/g;

function namesManaged(text: string, managed: ReadonlySet<string>): boolean {
	for (const match of text.matchAll(QUALIFIED)) {
		if (managed.has(match[1])) return true;
	}
	return false;
}

/** CREATE/ALTER SCHEMA of a managed schema, or an object named inside one. */
function targetsManagedSchema(
	statement: string,
	managed: ReadonlySet<string>,
): boolean {
	if (managed.size === 0) return false;
	const schemaDdl =
		/^(?:create|alter)\s+schema\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_$]*)"?/.exec(
			statement,
		);
	if (schemaDdl) return managed.has(schemaDdl[1]);
	if (/^(?:grant|revoke)\b/.test(statement)) {
		return grantsOnManaged(statement, managed);
	}
	if (!/^(?:create|alter|drop)\b/.test(statement)) return false;
	// The object a DDL statement is about is the first qualified name before
	// its first "(": `create function auth.f(` and `create policy p on auth.t`
	// match, `create table public.t (c uuid references auth.users)` does not.
	const head = statement.split("(")[0];
	const qualified = /"?([a-z_][a-z0-9_$]*)"?\s*\.\s*"?[a-z_]/.exec(head);
	return !!qualified && managed.has(qualified[1]);
}

/**
 * GRANT/REVOKE of privileges on objects of a managed schema: `on auth.users`
 * (any qualified object, functions included), `on schema auth` and
 * `on all tables in schema auth` (also sequences, functions, procedures,
 * routines). A grant without `on` is a role membership (`privileges`).
 */
function grantsOnManaged(
	statement: string,
	managed: ReadonlySet<string>,
): boolean {
	const target = /\bon\s+(.*?)\s+(?:to|from)\s/.exec(`${statement} `)?.[1];
	if (!target) return false;
	const schemas =
		/^(?:all\s+(?:tables|sequences|functions|procedures|routines)\s+in\s+)?schema\s+(.*)$/.exec(
			target,
		);
	if (schemas) return pathNamesManaged(schemas[1], managed);
	return namesManaged(target, managed);
}

/**
 * Rows changed or removed in a managed schema: TRUNCATE of a qualified
 * table, DELETE FROM / UPDATE / MERGE INTO one (also after a WITH clause).
 * INSERT is routine and destroys nothing (a storage bucket, seed rows), so
 * it is not asked about. `on conflict do update set` and `for update of t`
 * name no table.
 */
function writesManagedData(
	statement: string,
	managed: ReadonlySet<string>,
): boolean {
	if (managed.size === 0) return false;
	const truncate = /^truncate\b(.*)$/.exec(statement);
	if (truncate) return namesManaged(truncate[1], managed);
	for (const match of statement.matchAll(
		/\b(?:delete\s+from|update|merge\s+into)\s+(?:only\s+)?"?([a-z_][a-z0-9_$]*)"?\s*\.\s*"?[a-z_]/g,
	)) {
		if (managed.has(match[1])) return true;
	}
	return false;
}

/** Schema names of a search_path value (`auth, "$user"`, quotes dropped). */
function pathNamesManaged(
	value: string,
	managed: ReadonlySet<string>,
): boolean {
	return value
		.replace(/['"]/g, " ")
		.split(/[\s,]+/)
		.some((name) => managed.has(name));
}

/**
 * `set search_path ...` or `set_config('search_path', ...)` naming a
 * managed schema: unqualified DDL afterwards lands in it. Reads `words`,
 * the statement with its literals reduced to words (`scanSql`).
 */
function pointsPathAtManaged(
	words: string,
	managed: ReadonlySet<string>,
): boolean {
	if (managed.size === 0) return false;
	const set =
		/^set\s+(?:(?:session|local)\s+)?search_path\s*(?:to|=)\s*(.*)$/.exec(
			words,
		);
	if (set && pathNamesManaged(set[1], managed)) return true;
	for (const match of words.matchAll(
		/\bset_config\s*\(\s*'\s*search_path\s*'\s*,\s*'([^']*)'/g,
	)) {
		if (pathNamesManaged(match[1], managed)) return true;
	}
	return false;
}

/** The risks of one statement (`masked`: `maskSql`; `words`: see above). */
function statementRisks(
	masked: string,
	words: string,
	managed: ReadonlySet<string>,
): SqlRisk[] {
	const risks: SqlRisk[] = [];
	if (/^drop\s+schema\b/.test(masked)) risks.push("drop_schema");
	if (/^drop\s+database\b/.test(masked)) risks.push("drop_database");
	if (
		/^(?:create|alter|drop)\s+(?:role|user|group)\b/.test(masked) ||
		/^alter\s+system\b/.test(masked)
	) {
		risks.push("roles");
	}
	if (
		// Role membership (`grant supabase_admin to anon`): no `on <object>`.
		(/^(?:grant|revoke)\b/.test(masked) && !/\bon\b/.test(masked)) ||
		/^(?:drop|reassign)\s+owned\b/.test(masked) ||
		/^alter\s+default\s+privileges\b/.test(masked)
	) {
		risks.push("privileges");
	}
	if (
		/^set\s+(?:(?:session|local)\s+)?(?:role\b|session\s+authorization\b)/.test(
			masked,
		) ||
		/\bset_config\s*\(\s*'\s*role\s*'/.test(words)
	) {
		risks.push("session_role");
	}
	if (/^copy\b.*\bprogram\b/.test(masked)) risks.push("program");
	if (
		/^copy\b.*\b(?:from|to)\s+(?:e\s*)?'/.test(masked) ||
		/\blo_(?:import|export)\s*\(/.test(masked)
	) {
		risks.push("server_files");
	}
	if (/^(?:drop|alter)\s+extension\b/.test(masked)) risks.push("extensions");
	if (targetsManagedSchema(masked, managed)) risks.push("managed_schema");
	if (writesManagedData(masked, managed)) risks.push("managed_data");
	if (pointsPathAtManaged(words, managed)) risks.push("search_path");
	return risks;
}

/**
 * Statements of `sql` that deserve an explicit confirmation: dropping a
 * schema or database; changing roles, role memberships, ownership, default
 * privileges or server settings; switching the session's role; running a
 * program or reading/writing server files (`COPY ... PROGRAM`, `COPY ...
 * TO/FROM '<path>'`, `lo_import`/`lo_export`); dropping or altering an
 * extension; and DDL, grants, row changes or deletes, or a search_path
 * aimed at a schema the template manages (`managedSchemas`). Only looks at the
 * statement text (comments are ignored, strings and dollar-quoted bodies
 * are opaque), so it is a guard rail against mistakes, not a security
 * boundary: a superuser can always build the same statement dynamically
 * (`DO $$ ... EXECUTE ... $$`). Names are compared lowercased, quoted or
 * not, so `"AUTH".users` (a different schema from `auth`) is flagged too:
 * erring that way only costs an extra confirmation.
 */
export function analyzeSqlRisk(
	sql: string,
	managedSchemas: readonly string[],
): SqlRisk[] {
	const managed = new Set(managedSchemas.map((name) => name.toLowerCase()));
	const found = new Set<SqlRisk>();
	// Literals hold no `;` in either form: the statements line up.
	const words = scanSql(sql, "words").split(";");
	maskSql(sql)
		.split(";")
		.forEach((part, index) => {
			const masked = part.trim().toLowerCase();
			if (!masked) return;
			const statementWords = (words[index] ?? "").trim().toLowerCase();
			for (const risk of statementRisks(masked, statementWords, managed)) {
				found.add(risk);
			}
		});
	return SQL_RISKS.filter((risk) => found.has(risk));
}
