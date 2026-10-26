import path from "node:path";
import { hiddenFileName } from "#/config/identifiers.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { assertContainerName } from "#/server/services/gateway.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { internalError } from "#/utils/error.ts";

/**
 * Edge function files live in the functions container's volume. Every write
 * goes through the container (`docker cp` of a tar on stdin, `docker exec`
 * for rm/mv) and never through the host path: the container owns that
 * directory and could plant symlinks pointing anywhere on the host.
 * Pure builders: the exact commands are unit-tested.
 */

/** Function (folder) names: lowercase slug, like Supabase's CLI. */
const FUNCTION_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
/**
 * Shared code folders next to the functions (`_shared`): imported by
 * functions, never served (the router only serves function names).
 */
export const SHARED_DIR_PATTERN = /^_[a-z0-9][a-z0-9_-]{0,61}$/;
/** Relative file path inside a function: plain segments, no dotfiles. */
const FILE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const MAX_PATH = 200;

/** Directory name prefix of staged uploads (hidden from listings). */
export const STAGING_PREFIX = hiddenFileName("staging-");

export function assertFunctionName(
	name: string,
	reserved: readonly string[] = [],
): string {
	if (!FUNCTION_NAME_PATTERN.test(name)) {
		throw new TemplateError("FUNCTION_NAME_INVALID", { name });
	}
	if (reserved.includes(name)) {
		throw new TemplateError("FUNCTION_NAME_RESERVED", { name });
	}
	return name;
}

/**
 * Names a shared-folder operation accepts: `_x` folders, plus plain slug names
 * for folders that already exist without an entrypoint (`lib`). Whether a
 * folder really is shared code is decided by `classifyFolder` before any write.
 */
export function assertSharedFolderName(
	name: string,
	reserved: readonly string[] = [],
): string {
	if (!SHARED_DIR_PATTERN.test(name) && !FUNCTION_NAME_PATTERN.test(name)) {
		throw new TemplateError("FUNCTION_NAME_INVALID", { name });
	}
	if (reserved.includes(name)) {
		throw new TemplateError("FUNCTION_NAME_RESERVED", { name });
	}
	return name;
}

/** Name for a NEW shared folder: Supabase's convention, a leading underscore. */
export function assertNewSharedFolderName(
	name: string,
	reserved: readonly string[] = [],
): string {
	if (!SHARED_DIR_PATTERN.test(name)) {
		throw new TemplateError("SHARED_NAME_INVALID", { name });
	}
	if (reserved.includes(name)) {
		throw new TemplateError("FUNCTION_NAME_RESERVED", { name });
	}
	return name;
}

type FolderKind = "function" | "shared";

export interface FolderEntry {
	name: string;
	kind: FolderKind;
	updatedAt: string | null;
}

/**
 * Kind of a top-level folder of the functions directory, or null for names
 * that are neither (reserved, odd names). `_name` folders are shared code
 * (Supabase's convention); a plain name with an entrypoint file is a function;
 * a plain name without one is shared code too, but only when the template
 * names its entrypoints (otherwise every folder would look shared).
 */
export function classifyFolder(
	name: string,
	hasEntrypoint: boolean,
	options: { reserved: readonly string[]; entrypointsKnown: boolean },
): FolderKind | null {
	if (options.reserved.includes(name)) return null;
	if (SHARED_DIR_PATTERN.test(name)) return "shared";
	if (!FUNCTION_NAME_PATTERN.test(name)) return null;
	if (hasEntrypoint || !options.entrypointsKnown) return "function";
	return "shared";
}

export function assertFunctionFilePath(file: string): string {
	const segments = file.split("/");
	if (
		file.length === 0 ||
		file.length > MAX_PATH ||
		path.posix.normalize(file) !== file ||
		!segments.every((segment) => FILE_SEGMENT.test(segment))
	) {
		throw new TemplateError("FUNCTION_FILE_PATH_INVALID", { path: file });
	}
	return file;
}

/** Absolute container directory, e.g. `/home/deno/functions`. */
function assertContainerDir(dir: string): string {
	if (
		!/^\/[A-Za-z0-9_./-]+$/.test(dir) ||
		path.posix.normalize(dir) !== dir ||
		dir.endsWith("/") ||
		dir.split("/").includes("..")
	) {
		throw internalError(`Invalid container directory "${dir}"`);
	}
	return dir;
}

export { assertContainerName };

export interface FunctionFile {
	path: string;
	/** Text from the editor, or raw bytes (imported wasm, images, fonts). */
	content: string | Buffer;
}

/** A function file as the editor shows it (text). */
export interface FunctionTextFile {
	path: string;
	content: string;
}

export function assertFunctionFiles(
	files: FunctionFile[],
	limits: { maxFiles: number; maxBytes: number },
): FunctionFile[] {
	if (files.length === 0) throw new TemplateError("FUNCTION_NO_FILES");
	if (files.length > limits.maxFiles) {
		throw new TemplateError("FUNCTION_TOO_MANY_FILES", {
			max: limits.maxFiles,
		});
	}
	const seen = new Set<string>();
	let total = 0;
	for (const file of files) {
		assertFunctionFilePath(file.path);
		if (seen.has(file.path)) {
			throw new TemplateError("FUNCTION_FILE_DUPLICATE", { path: file.path });
		}
		// A file and a directory with the same name cannot both exist.
		for (const other of seen) {
			if (
				other.startsWith(`${file.path}/`) ||
				file.path.startsWith(`${other}/`)
			) {
				throw new TemplateError("FUNCTION_FILE_CONFLICT", {
					path: file.path,
					other,
				});
			}
		}
		seen.add(file.path);
		total += Buffer.byteLength(file.content);
	}
	if (total > limits.maxBytes) {
		throw new TemplateError("FUNCTION_TOO_LARGE", {
			max: { $bytes: limits.maxBytes },
		});
	}
	return files;
}

// ---------------------------------------------------------------------------
// Minimal ustar writer/reader (regular files + directories only).

const BLOCK = 512;

function writeString(
	header: Buffer,
	offset: number,
	length: number,
	value: string,
) {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length > length)
		throw new TemplateError("FUNCTION_PATH_TOO_LONG", { path: value });
	bytes.copy(header, offset);
}

function writeOctal(
	header: Buffer,
	offset: number,
	length: number,
	value: number,
) {
	writeString(
		header,
		offset,
		length,
		`${value.toString(8).padStart(length - 1, "0")}\0`,
	);
}

/** Split a path over ustar `prefix` (155) and `name` (100). */
function splitTarPath(entry: string): { name: string; prefix: string } {
	if (Buffer.byteLength(entry) <= 100) return { name: entry, prefix: "" };
	const slash = entry.lastIndexOf("/", entry.length - 2);
	const prefix = entry.slice(0, slash);
	const name = entry.slice(slash + 1);
	if (
		slash <= 0 ||
		Buffer.byteLength(prefix) > 155 ||
		Buffer.byteLength(name) > 100
	) {
		throw new TemplateError("FUNCTION_PATH_TOO_LONG", { path: entry });
	}
	return { name, prefix };
}

function tarHeader(
	entry: string,
	type: "file" | "dir",
	size: number,
	mtime: number,
): Buffer {
	const header = Buffer.alloc(BLOCK, 0);
	const { name, prefix } = splitTarPath(entry);
	writeString(header, 0, 100, name);
	writeOctal(header, 100, 8, type === "dir" ? 0o755 : 0o644);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, 124, 12, size);
	writeOctal(header, 136, 12, mtime);
	header.fill(" ", 148, 156);
	header[156] = (type === "dir" ? "5" : "0").charCodeAt(0);
	writeString(header, 257, 6, "ustar\0");
	writeString(header, 263, 2, "00");
	writeString(header, 265, 32, "root");
	writeString(header, 297, 32, "root");
	writeString(header, 345, 155, prefix);
	let sum = 0;
	for (const byte of header) sum += byte;
	writeString(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
	return header;
}

/**
 * Tar with `root/` and every file under it (directories first). Entries are
 * sorted so the output is deterministic for a given input and mtime.
 */
export function buildTar(
	root: string,
	files: { path: string; content: string | Buffer }[],
	mtime = Math.floor(Date.now() / 1000),
): Buffer {
	const dirs = new Set<string>([root]);
	for (const file of files) {
		const parts = file.path.split("/");
		for (let i = 1; i < parts.length; i++) {
			dirs.add(`${root}/${parts.slice(0, i).join("/")}`);
		}
	}
	const chunks: Buffer[] = [];
	for (const dir of [...dirs].sort()) {
		chunks.push(tarHeader(`${dir}/`, "dir", 0, mtime));
	}
	for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
		const content =
			typeof file.content === "string"
				? Buffer.from(file.content, "utf8")
				: file.content;
		chunks.push(
			tarHeader(`${root}/${file.path}`, "file", content.length, mtime),
		);
		chunks.push(content);
		const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
		if (pad) chunks.push(Buffer.alloc(pad, 0));
	}
	chunks.push(Buffer.alloc(BLOCK * 2, 0));
	return Buffer.concat(chunks);
}

function readString(buf: Buffer, offset: number, length: number): string {
	const end = buf.indexOf(0, offset);
	return buf
		.subarray(
			offset,
			end === -1 || end > offset + length ? offset + length : end,
		)
		.toString("utf8");
}

/**
 * Regular files of a tar (as produced by `docker cp <c>:<dir>/. -`). Paths
 * are made relative (leading `./` removed); symlinks, devices and anything
 * with an unsafe path are skipped. PAX/GNU long-name records are honoured.
 */
export function parseTar(
	buf: Buffer,
	limits: { maxFiles: number; maxBytes: number },
): { files: FunctionTextFile[]; skipped: string[] } {
	const { files, skipped } = parseTarBytes(buf, limits);
	return {
		files: files.map((file) => ({
			path: file.path,
			content: file.content.toString("utf8"),
		})),
		skipped,
	};
}

/** `parseTar` keeping each file's bytes (wasm, images, fonts). */
export function parseTarBytes(
	buf: Buffer,
	limits: { maxFiles: number; maxBytes: number },
): { files: { path: string; content: Buffer }[]; skipped: string[] } {
	const files: { path: string; content: Buffer }[] = [];
	const skipped: string[] = [];
	let offset = 0;
	let total = 0;
	let longName: string | null = null;
	while (offset + BLOCK <= buf.length) {
		const header = buf.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) break;
		const size = Number.parseInt(readString(header, 124, 12).trim() || "0", 8);
		const type = String.fromCharCode(header[156] || 48);
		const prefix = readString(header, 345, 155);
		let name = readString(header, 0, 100);
		if (prefix) name = `${prefix}/${name}`;
		const dataStart = offset + BLOCK;
		const data = buf.subarray(dataStart, dataStart + size);
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

		if (type === "L") {
			longName = data.toString("utf8").replace(/\0+$/, "");
			continue;
		}
		if (type === "x") {
			const match = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
			if (match) longName = match[1];
			continue;
		}
		if (type === "g") continue;
		if (longName !== null) {
			name = longName;
			longName = null;
		}
		const relative = name.replace(/^(\.\/)+/, "").replace(/\/$/, "");
		if (type === "5" || relative === "" || relative === ".") continue;
		if (type !== "0" && type !== "\0") {
			skipped.push(relative);
			continue;
		}
		try {
			assertFunctionFilePath(relative);
		} catch {
			skipped.push(relative);
			continue;
		}
		total += size;
		if (files.length >= limits.maxFiles || total > limits.maxBytes) {
			throw new TemplateError("FUNCTION_SOURCE_LIMITS");
		}
		files.push({ path: relative, content: Buffer.from(data) });
	}
	return { files, skipped };
}

// ---------------------------------------------------------------------------
// Commands (run on the managed host)

/** Exit code when the target container is not running. */
export const NOT_RUNNING_EXIT = 96;

function runningGuard(container: string): string {
	return `[ "$(docker inspect -f '{{.State.Running}}' ${q(container)} 2>/dev/null)" = true ] || { echo "Container is not running" >&2; exit ${NOT_RUNNING_EXIT}; }`;
}

/**
 * POSIX sh loop over the top-level folders of the current dir (dotfiles,
 * hence staging dirs, and symlinks skipped): `body` runs per folder with
 * `$n` = name and `$t` = mtime in epoch seconds (empty when unknown). No
 * `find -printf` (GNU only): `stat -c` (GNU, busybox) with a `stat -f`
 * (BSD) fallback.
 */
function eachFolderScript(body: string): string {
	return [
		"for d in ./*/; do",
		'n="$(basename "$d")";',
		'{ [ -d "$n" ] && [ ! -L "$n" ]; } || continue;',
		't="$(stat -c %Y "$n" 2>/dev/null || stat -f %m "$n" 2>/dev/null)";',
		body,
		"done",
	].join(" ");
}

/** Inner sh script: `name<TAB>mtime` per function folder. */
export function functionListScript(dir: string): string {
	return `cd ${q(assertContainerDir(dir))} && ${eachFolderScript(`printf '%s\\t%s\\n' "$n" "$t";`)}`;
}

/** `name<TAB>mtime` per function folder (staging dirs and dotfiles hidden). */
export function listFunctionsCommand(container: string, dir: string): string {
	const script = functionListScript(dir);
	return [
		runningGuard(assertContainerName(container)),
		`docker exec ${q(container)} sh -c ${q(script)}`,
	].join("\n");
}

const ENTRYPOINT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * Inner sh script: one line `name<TAB>mtime<TAB>1|0` per top-level folder
 * (staging dirs and dotfiles hidden); 1 = the folder holds one of the
 * entrypoint files.
 */
export function foldersScript(
	dir: string,
	entrypoints: readonly string[],
): string {
	for (const entry of entrypoints) {
		if (!ENTRYPOINT_NAME.test(entry)) {
			throw internalError(`Invalid entrypoint name "${entry}"`);
		}
	}
	const probe = entrypoints
		.map((entry) => `[ -f "$n/${entry}" ] && has=1;`)
		.join(" ");
	return [
		`cd ${q(assertContainerDir(dir))}`,
		eachFolderScript(
			`has=0; ${probe} printf '%s\\t%s\\t%s\\n' "$n" "$t" "$has";`,
		),
	].join(" && ");
}

/** `foldersScript` run inside the functions container. */
export function listFoldersCommand(
	container: string,
	dir: string,
	entrypoints: readonly string[],
): string {
	return [
		runningGuard(assertContainerName(container)),
		`docker exec ${q(container)} sh -c ${q(foldersScript(dir, entrypoints))}`,
	].join("\n");
}

/**
 * Tar of one function folder, base64 on stdout (read via the daemon, so a
 * symlink in the volume resolves inside the container). An empty stdout with
 * stderr means the folder does not exist.
 */
export function readFunctionCommand(
	container: string,
	dir: string,
	name: string,
	/** `name` is a shared folder (`_shared`), not a function. */
	options: { shared?: boolean } = {},
): string {
	const folder = options.shared
		? assertSharedFolderName(name)
		: assertFunctionName(name);
	const source = `${assertContainerName(container)}:${assertContainerDir(dir)}/${folder}/.`;
	return `docker cp ${q(source)} - | base64`;
}

/**
 * Deploy a function: stdin is a tar whose root is `staging`; `docker cp -`
 * extracts it inside the container, then the container swaps it into place
 * (`rm -rf` removes a planted symlink itself, never its target).
 */
export function deployFunctionScript(
	container: string,
	dir: string,
	name: string,
	staging: string,
	/** `name` is a shared folder (`_shared`), not a function. */
	options: { shared?: boolean } = {},
): string {
	assertContainerName(container);
	assertContainerDir(dir);
	if (options.shared) assertSharedFolderName(name);
	else assertFunctionName(name);
	if (!new RegExp(`^${STAGING_PREFIX}[a-z0-9_-]+$`).test(staging)) {
		throw internalError(`Invalid staging name "${staging}"`);
	}
	const swap = 'cd "$1" && rm -rf -- "$2" && mv -T -- "$3" "$2"';
	return [
		"set -e",
		runningGuard(container),
		`docker cp - ${q(`${container}:${dir}`)}`,
		`docker exec ${q(container)} sh -c ${q(swap)} sh ${q(dir)} ${q(name)} ${q(staging)}`,
	].join("\n");
}

export function deleteFunctionCommand(
	container: string,
	dir: string,
	name: string,
	/** `name` is a shared folder (`_shared`), not a function. */
	options: { shared?: boolean } = {},
): string {
	assertContainerName(container);
	const folder = options.shared
		? assertSharedFolderName(name)
		: assertFunctionName(name);
	const target = `${assertContainerDir(dir)}/${folder}`;
	return [
		runningGuard(container),
		`docker exec ${q(container)} rm -rf -- ${q(target)}`,
	].join("\n");
}

/** Remove leftover staging dirs (failed deploys). */
export function cleanupStagingCommand(container: string, dir: string): string {
	const script = `cd ${q(assertContainerDir(dir))} && rm -rf -- ./${STAGING_PREFIX}*`;
	return `docker exec ${q(assertContainerName(container))} sh -c ${q(script)} || true`;
}

export interface FunctionEntry {
	name: string;
	updatedAt: string | null;
}

export function parseFunctionList(
	output: string,
	hidden: readonly string[],
): FunctionEntry[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [name = "", mtime = ""] = line.split("\t");
			const seconds = Number(mtime);
			return {
				name,
				updatedAt:
					Number.isFinite(seconds) && seconds > 0
						? new Date(seconds * 1000).toISOString()
						: null,
			};
		})
		.filter(
			(entry) =>
				FUNCTION_NAME_PATTERN.test(entry.name) && !hidden.includes(entry.name),
		)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** `listFoldersCommand` output as classified entries, sorted by name. */
export function parseFolderList(
	output: string,
	options: { reserved: readonly string[]; entrypointsKnown: boolean },
): FolderEntry[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			const [name = "", mtime = "", entry = ""] = line.split("\t");
			const kind = classifyFolder(name, entry === "1", options);
			if (!kind) return [];
			const seconds = Number(mtime);
			return [
				{
					name,
					kind,
					updatedAt:
						Number.isFinite(seconds) && seconds > 0
							? new Date(seconds * 1000).toISOString()
							: null,
				},
			];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}
