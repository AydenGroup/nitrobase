import { shellQuote as q } from "#/server/services/executor.ts";
import { quoteLiteral } from "#/server/services/supabase/sql.ts";
import { internalError } from "#/utils/error.ts";

/**
 * Commands of a cloud sync job on the target server (pure builders, the
 * exact text is unit-tested). Credentials never appear in argv or env:
 * libpq reads them from a 0600 pg_service.conf + pgpass in the job's
 * staging folder, mounted read-only into a throwaway client container.
 */

/** Cloud credentials: the dump container (and rclone's config) only. */
export const SECRETS_DIR = "secrets";
/** The app database's credentials: the load container only. */
export const LOAD_SECRETS_DIR = "secrets-load";
export const DUMP_DIR = "dump";
export const LOGS_DIR = "logs";
/** Both ends' storage keys: the rclone container only. */
export const RCLONE_SECRETS_DIR = "secrets-rclone";

/**
 * Staging layout: the dump's and the load's credential folders (each its
 * container's only ro mount), rclone's, dumps, logs.
 */
export function prepareSyncWorkDirCommand(workDir: string): string {
	return `umask 077 && mkdir -p ${[
		SECRETS_DIR,
		LOAD_SECRETS_DIR,
		RCLONE_SECRETS_DIR,
		DUMP_DIR,
		LOGS_DIR,
	]
		.map((dir) => q(`${workDir}/${dir}`))
		.join(" ")}`;
}

export interface PgEndpoint {
	/** Name (TLS verification, pgpass match). */
	host: string;
	/** Address to connect to (pinned); omitted: resolve `host`. */
	hostaddr?: string;
	port: number;
	user: string;
	dbname: string;
	sslmode: "verify-full" | "require" | "disable";
	/** Path of the CA bundle inside the container. */
	sslrootcert?: string;
	password: string;
}

const SINGLE_LINE = /^[^\r\n\0]*$/;

function assertLine(value: string): string {
	if (!SINGLE_LINE.test(value)) throw internalError("Invalid connection value");
	return value;
}

/** pg_service.conf with one section per endpoint (no passwords). */
export function pgServiceFile(services: Record<string, PgEndpoint>): string {
	const lines: string[] = [];
	for (const [name, endpoint] of Object.entries(services)) {
		if (!/^[a-z][a-z0-9_]*$/.test(name)) {
			throw internalError(`Invalid service name "${name}"`);
		}
		lines.push(`[${name}]`);
		const entries: [string, string | number | undefined][] = [
			["host", endpoint.host],
			["hostaddr", endpoint.hostaddr],
			["port", endpoint.port],
			["user", endpoint.user],
			["dbname", endpoint.dbname],
			["sslmode", endpoint.sslmode],
			["sslrootcert", endpoint.sslrootcert],
		];
		for (const [key, value] of entries) {
			if (value === undefined || value === "") continue;
			lines.push(`${key}=${assertLine(String(value))}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** `\` and `:` are escaped in pgpass fields. */
const pgpassField = (value: string) =>
	assertLine(value).replace(/[\\:]/g, (char) => `\\${char}`);

/** pgpass lines, one per endpoint (matched on host name, port, db, user). */
export function pgpassFile(endpoints: PgEndpoint[]): string {
	return `${endpoints
		.map((endpoint) =>
			[
				endpoint.host,
				String(endpoint.port),
				endpoint.dbname,
				endpoint.user,
				endpoint.password,
			]
				.map(pgpassField)
				.join(":"),
		)
		.join("\n")}\n`;
}

/** pg_service.conf sections of the two ends. */
export const DUMP_SERVICE = "cloud";
export const LOAD_SERVICE = "local";

export interface PgClientRun {
	image: string;
	workDir: string;
	/**
	 * dump: the source's credentials (`SECRETS_DIR`), dump folder
	 * writable; load: the destination's only (`LOAD_SECRETS_DIR`), dumps
	 * read-only. An import dumps the cloud and loads the app; an export
	 * the other way round.
	 */
	mode: "dump" | "load";
	/** pg_service.conf section (default: the import's for `mode`). */
	service?: string;
	/** Docker network (`container:<name>` shares a container's). */
	network?: string;
	/** pg_dump / pg_dumpall / psql argv (each argument is quoted). */
	argv: string[];
	/** Host file receiving stderr (errors are counted from it). */
	stderrFile?: string;
}

const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*:[\w.-]+$/;

function assertService(name: string): string {
	if (!/^[a-z][a-z0-9_]*$/.test(name)) {
		throw internalError(`Invalid service name "${name}"`);
	}
	return name;
}
const NETWORK_PATTERN = /^(container:)?[a-z0-9][a-z0-9_.-]*$/;
const CLIENTS = new Set(["pg_dump", "pg_dumpall", "psql"]);

/** `docker run` of a Postgres client with the staged credentials. */
export function pgClientCommand(run: PgClientRun): string {
	if (!IMAGE_PATTERN.test(run.image)) {
		throw internalError(`Invalid image "${run.image}"`);
	}
	if (run.network && !NETWORK_PATTERN.test(run.network)) {
		throw internalError(`Invalid network "${run.network}"`);
	}
	if (!CLIENTS.has(run.argv[0] ?? "")) {
		throw internalError(`Invalid client "${run.argv[0]}"`);
	}
	const load = run.mode === "load";
	const secrets = `${run.workDir}/${load ? LOAD_SECRETS_DIR : SECRETS_DIR}`;
	const dump = `${run.workDir}/${DUMP_DIR}`;
	return [
		// --init: the client isn't PID 1, so TERM (cancel, timeout) stops it.
		"docker run --rm -i --init",
		...(run.network ? [`--network ${q(run.network)}`] : []),
		`-v ${q(`${secrets}:/secrets:ro`)}`,
		`-v ${q(`${dump}:/dump${load ? ":ro" : ""}`)}`,
		"-e PGSERVICEFILE=/secrets/pg_service.conf",
		"-e PGPASSFILE=/secrets/pgpass",
		`-e PGSERVICE=${assertService(run.service ?? (load ? LOAD_SERVICE : DUMP_SERVICE))}`,
		q(run.image),
		...run.argv.map(q),
		...(run.stderrFile ? [`2> ${q(run.stderrFile)}`] : []),
	].join(" ");
}

/**
 * Pinned Postgres client image of a major version (CLOUD_SYNC_PG_CLIENT_IMAGES);
 * null when none is configured for it.
 */
export function clientImage(
	images: Record<string, string>,
	major: number,
): string | null {
	if (!Number.isInteger(major) || major < 9 || major > 99) {
		throw internalError(`Invalid Postgres major "${major}"`);
	}
	const image = images[String(major)];
	return image && IMAGE_PATTERN.test(image) ? image : null;
}

/** psql meta-commands pg_dump ≥ 17.6 writes around a dump (restrict mode). */
const RESTRICT_LINE = /^\\(restrict|unrestrict) [A-Za-z0-9]+$/;
const COPY_FROM_STDIN = /^COPY .+ FROM stdin;$/;

/**
 * Check of a data dump on the server (it can be large: never pulled to the
 * panel). pg_dump --data-only writes SET/SELECT lines, COPY headers and
 * data; outside COPY data no line may hold a backslash (psql would run it
 * as a meta-command, e.g. `\! curl …`), except the `\restrict` pair.
 * Exit 3 + the offending line number on stdout; exit 4: unterminated COPY.
 */
export function dataDumpCheckCommand(file: string): string {
	const program = [
		'copy == 1 { if ($0 == "\\\\.") copy = 0; next }',
		"/^COPY .+ FROM stdin;$/ { copy = 1; next }",
		"/^\\\\(restrict|unrestrict) [A-Za-z0-9]+$/ { next }",
		"/\\\\/ { print FNR; bad = 1; exit 3 }",
		"END { if (!bad && copy == 1) { print NR; exit 4 } }",
	].join("\n");
	return `awk ${q(program)} ${q(file)}`;
}

/**
 * First backslash outside literals, quoted identifiers, comments and COPY
 * data of a (small) dump read into the panel, as a 1-based line number;
 * null when there is none. `\restrict`/`\unrestrict` lines are allowed.
 */
export function findMetaCommand(text: string): number | null {
	let line = 1;
	let i = 0;
	let atLineStart = true;
	const n = text.length;
	while (i < n) {
		const char = text[i];
		if (atLineStart) {
			const end = text.indexOf("\n", i);
			const whole = text.slice(i, end < 0 ? n : end);
			if (RESTRICT_LINE.test(whole)) {
				i = end < 0 ? n : end;
				continue;
			}
			if (COPY_FROM_STDIN.test(whole)) {
				// Skip the data up to its `\.` line.
				let at = end;
				for (;;) {
					if (at < 0) return null;
					line++;
					const next = text.indexOf("\n", at + 1);
					const row = text.slice(at + 1, next < 0 ? n : next);
					at = next;
					if (row === "\\.") break;
				}
				i = at < 0 ? n : at;
				continue;
			}
			atLineStart = false;
		}
		if (char === "\n") {
			line++;
			atLineStart = true;
			i++;
			continue;
		}
		if (char === "\\") return line;
		if (char === "-" && text[i + 1] === "-") {
			const end = text.indexOf("\n", i);
			i = end < 0 ? n : end;
			continue;
		}
		if (char === "/" && text[i + 1] === "*") {
			let depth = 1;
			i += 2;
			while (i < n && depth > 0) {
				if (text[i] === "\n") line++;
				if (text[i] === "/" && text[i + 1] === "*") {
					depth++;
					i += 2;
				} else if (text[i] === "*" && text[i + 1] === "/") {
					depth--;
					i += 2;
				} else i++;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			// E'…' strings escape with backslashes; plain ones double quotes.
			const escapes = char === "'" && /[eE]$/.test(text.slice(i - 1, i));
			i++;
			while (i < n) {
				if (text[i] === "\n") line++;
				if (escapes && text[i] === "\\") {
					i += 2;
					continue;
				}
				if (text[i] === char) {
					if (text[i + 1] === char) {
						i += 2;
						continue;
					}
					break;
				}
				i++;
			}
			i++;
			continue;
		}
		if (char === "$") {
			const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
			if (tag) {
				const close = text.indexOf(tag[0], i + tag[0].length);
				const stop = close < 0 ? n : close + tag[0].length;
				for (let k = i; k < stop; k++) if (text[k] === "\n") line++;
				i = stop;
				continue;
			}
		}
		i++;
	}
	return null;
}

/** psql argv of the load: roles → schema → replica mode → data (→ vault). */
export function restoreArgv(files: string[]): string[] {
	const argv = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=0"];
	for (const file of files) {
		if (file === "data.sql") {
			// Triggers and FK checks off: rows load exactly as dumped.
			argv.push("-c", "SET session_replication_role = replica");
		}
		argv.push("-f", `/dump/${file}`);
	}
	return argv;
}

/** Bytes of a file (`wc -c`, portable). */
export function fileSizeCommand(file: string): string {
	return `wc -c < ${q(file)}`;
}

/** Free bytes of the filesystem holding `path` (POSIX df). */
export function freeDiskCommand(path: string): string {
	return `df -Pk ${q(path)} | tail -n 1`;
}

export function parseFreeDisk(output: string): number | null {
	const fields = output.trim().split(/\s+/);
	const kb = Number(fields[3]);
	return Number.isFinite(kb) ? kb * 1024 : null;
}

/**
 * Write `file` inside a container from stdin, as `user`, private (e.g. the
 * pgsodium root key, which must never reach argv or logs).
 */
export function writeContainerFileCommand(
	container: string,
	file: string,
	user: string,
): string {
	if (!/^[a-z0-9][a-z0-9_.-]*$/.test(container)) {
		throw internalError(`Invalid container "${container}"`);
	}
	if (!/^\/[A-Za-z0-9_./-]+$/.test(file) || file.includes("..")) {
		throw internalError(`Invalid file "${file}"`);
	}
	if (!/^[a-z_][a-z0-9_-]*$/.test(user)) {
		throw internalError(`Invalid user "${user}"`);
	}
	return `docker exec -i -u ${q(user)} ${q(container)} sh -c ${q('umask 077 && cat > "$1"')} sh ${q(file)}`;
}

/** First line: number of ERROR lines; then up to `max` of them. */
export function errorLinesCommand(file: string, max: number): string {
	return `grep -c 'ERROR:' ${q(file)} || true; grep 'ERROR:' ${q(file)} | head -n ${Math.max(1, Math.floor(max))}`;
}

export function parseErrorLines(output: string): {
	count: number;
	lines: string[];
} {
	const [first = "0", ...rest] = output.split("\n");
	return {
		count: Number(first.trim()) || 0,
		lines: rest.map((line) => line.trim()).filter(Boolean),
	};
}

/**
 * Errors the destination's own objects cause: expected, not counted. An
 * export also meets `OWNER TO` a platform role the cloud's postgres may
 * not become (the object then stays owned by postgres).
 */
export const EXPECTED_LOAD_ERRORS =
	/already exists|cannot be dropped|must be owner of|permission denied to (create|alter) role|must be able to SET ROLE "supabase_/;

/**
 * Exact row counts of the tables in `schemas` plus `tables`, one statement
 * (`query_to_xml` runs a count per table), as `table|rows` lines.
 */
export function rowCountsSql(
	schemas: string[],
	tables: string[],
	limit: number,
): string {
	const array = (items: string[]) =>
		items.length
			? `ARRAY[${items.map(quoteLiteral).join(", ")}]::text[]`
			: "ARRAY[]::text[]";
	return [
		"select n.nspname || '.' || c.relname as t,",
		"(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint as n",
		"from pg_class c join pg_namespace n on n.oid = c.relnamespace",
		"where c.relkind in ('r', 'p') and not c.relispartition",
		`and (n.nspname = any(${array(schemas)}) or n.nspname || '.' || c.relname = any(${array(tables)}))`,
		`order by 1 limit ${Math.max(1, Math.floor(limit))}`,
	].join(" ");
}

/** `table|rows` lines (psql -A -t) → counts. */
export function parseRowCounts(output: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of output.split("\n")) {
		const at = line.lastIndexOf("|");
		if (at <= 0) continue;
		const rows = Number(line.slice(at + 1).trim());
		if (Number.isFinite(rows)) counts.set(line.slice(0, at), rows);
	}
	return counts;
}

/** rclone arguments of one bucket copy (destination listing ignored). */
export function bucketCopyArgs(
	bucket: string,
	transfers: number,
	logFile: string,
	/** Remotes (rclone.conf sections): cloud → local unless given. */
	ends: { from: string; to: string } = { from: "cloud", to: "local" },
): string[] {
	return [
		"copy",
		`${ends.from}:${bucket}`,
		`${ends.to}:${bucket}`,
		// The copied storage.objects rows make every object look present
		// already: copy without comparing against the destination.
		"--no-check-dest",
		"--transfers",
		String(Math.max(1, Math.floor(transfers))),
		"--log-file",
		logFile,
		"--log-level",
		"INFO",
		"--stats",
		"0",
	];
}

/** Buckets rclone can address (letters, digits, `.`, `_`, `-`). */
export const BUCKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** First line: files copied; then up to `max` ERROR lines of the log. */
export function copyLogSummaryCommand(file: string, max: number): string {
	return `grep -c ': Copied' ${q(file)} || true; grep 'ERROR' ${q(file)} | head -n ${Math.max(1, Math.floor(max))}`;
}
