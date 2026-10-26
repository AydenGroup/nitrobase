/**
 * Bind sources inside an app folder expected to be files, judged by name
 * when nothing better is known (no upstream listing, no rendered file):
 * a missing one is refused before `up` instead of letting Docker create an
 * empty directory in its place (which the service then fails to read,
 * e.g. "clickhouse-init.sh: Is a directory").
 *
 * Only unambiguous file names: data directories (e.g. `./pb_data`,
 * `./volumes/db/data`) have no extension, and a template can still declare
 * a folder as data (`[backup] paths`/`reset`) to exempt it.
 * Adding a type = an entry here.
 */
const BIND_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
	// Config
	"conf",
	"cfg",
	"cnf",
	"ini",
	"toml",
	"yml",
	"yaml",
	"json",
	"xml",
	"properties",
	"env",
	"exs",
	"lua",
	"tpl",
	// Scripts and code run at start-up
	"sh",
	"bash",
	"js",
	"mjs",
	"cjs",
	"ts",
	"py",
	"rb",
	"php",
	"sql",
	// Certificates and keys
	"pem",
	"crt",
	"cert",
	"key",
	"p12",
	"pfx",
	// Documents served as is
	"html",
	"txt",
	// Deliberately absent: database and state files (`db`, `sqlite`,
	// `sqlite3`, `rdb`, `aof`, `log`, `lock`, `pid`, `sock`, `bin`, `dat`).
	// Apps create those at runtime, and a few images expect a folder with
	// such a name (e.g. `./data.db/`): a bind source named so is treated as
	// a data folder, never warned about or refused.
]);

/** Extension-less file names that are always files. */
const BIND_FILE_NAMES: ReadonlySet<string> = new Set([
	"Caddyfile",
	"Dockerfile",
	"htpasswd",
	".htpasswd",
]);

/** True when a bind source's name says it is a file. */
export function looksLikeFile(source: string): boolean {
	const name = source.replace(/\/+$/, "").split("/").pop() ?? "";
	if (BIND_FILE_NAMES.has(name)) return true;
	const match = /^[^.].*\.([A-Za-z0-9]+)$/.exec(name);
	return !!match && BIND_FILE_EXTENSIONS.has(match[1].toLowerCase());
}
