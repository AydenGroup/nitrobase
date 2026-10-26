import path from "node:path";
import { hiddenFileName, resourceName } from "#/config/identifiers.ts";
import { getConfig } from "#/config/server.ts";
import {
	clampInt,
	DEFAULT_COLS,
	DEFAULT_ROWS,
	MAX_COLS,
	MAX_ROWS,
	MIN_COLS,
	MIN_ROWS,
} from "#/libs/terminal.ts";
import { AppError, internalError } from "#/utils/error.ts";

type ExecLogCallback = (chunk: string) => void;

export interface ExecOptions {
	onStdout?: ExecLogCallback;
	/** Raw stdout bytes (binary streams, e.g. a backup download). */
	onStdoutData?: (chunk: Buffer) => void;
	/**
	 * Called once the command runs, with pause/resume of its stdout, so a
	 * slow consumer can apply backpressure (the remote side blocks).
	 */
	onFlowControl?: (control: { pause: () => void; resume: () => void }) => void;
	onStderr?: ExecLogCallback;
	/** Data written to the command's stdin, then stdin is closed. */
	input?: string | Buffer;
	timeoutMs?: number;
	/** Abort terminates the command (used by live log streams). */
	signal?: AbortSignal;
	/** Don't buffer output in the result (long streams); use the callbacks. */
	discardOutput?: boolean;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface ShellSession {
	write: (data: string | Buffer) => void;
	resize: (rows: number, cols: number) => void;
	close: () => void;
}

export interface OpenShellOptions {
	cols?: number;
	rows?: number;
	onData: (data: string) => void;
	onClose: () => void;
	onError: (err: Error) => void;
	/**
	 * Run this trusted command in a PTY instead of a login shell (e.g. a
	 * `docker exec -it` into a container). Built by command builders only.
	 */
	command?: string;
}

/**
 * Runs trusted, server-generated commands on a managed host. One executor
 * per job: SSH executors reuse a single connection until `close()`.
 */
export interface Executor {
	readonly kind: "ssh" | "local";
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	/** Write a file under the managed root (parent dirs are created). */
	upload(
		content: string | Buffer,
		remotePath: string,
		mode?: string,
	): Promise<void>;
	readFile(remotePath: string): Promise<string>;
	shell(options: OpenShellOptions): Promise<ShellSession>;
	close(): void;
}

/** Default per-command timeout (config: COMMAND_TIMEOUT_MS). */
export function commandTimeoutMs(): number {
	return getConfig().COMMAND_TIMEOUT_MS;
}

/** Managed root with trailing slash (config: NITROBASE_ROOT). */
function managedRoot(): string {
	return `${getConfig().NITROBASE_ROOT}/`;
}

/**
 * Uploads may only target files under /etc/nitrobase. Rejects traversal
 * (`..`), relative paths, and non-normalized paths.
 */
export function assertManagedPath(remotePath: string): string {
	const root = managedRoot();
	const normalized = path.posix.normalize(remotePath);
	if (
		normalized !== remotePath ||
		!normalized.startsWith(root) ||
		normalized.split("/").includes("..")
	) {
		throw internalError(`Remote file access must stay under ${root}`);
	}
	return normalized;
}

/** Quote a value for POSIX sh. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PTY size clamped to the terminal protocol bounds (`#/libs/terminal.ts`). */
export function clampTerminalSize(options: { cols?: number; rows?: number }) {
	return {
		cols: clampInt(options.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS),
		rows: clampInt(options.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS),
	};
}

/** Exit code used by the managed file scripts when a path escapes the root. */
export const PATH_ESCAPE_EXIT = 97;

/**
 * Shell script (GNU coreutils) that writes stdin to `target` without ever
 * following symlinks out of /etc/nitrobase:
 * - every existing component of the parent dir must be a real directory
 *   (`realpath -m` of the dir must equal the dir) before `mkdir -p`;
 * - content goes to a temp file in the same dir, then `mv -T` replaces the
 *   target entry itself (a symlink at the target is replaced, not followed).
 */
export function managedWriteScript(target: string, mode = "0644"): string {
	const path = assertManagedPath(target);
	const dir = path.slice(0, path.lastIndexOf("/"));
	const q = shellQuote;
	return [
		"set -e",
		`dir=${q(dir)}`,
		`target=${q(path)}`,
		`[ "$(realpath -m -- "$dir")" = "$dir" ] || { echo "Refusing to write through a symlink: $dir" >&2; exit ${PATH_ESCAPE_EXIT}; }`,
		'mkdir -p -- "$dir"',
		`[ "$(realpath -e -- "$dir")" = "$dir" ] || { echo "Refusing to write through a symlink: $dir" >&2; exit ${PATH_ESCAPE_EXIT}; }`,
		`case "$dir/" in ${q(managedRoot())}*) ;; *) exit ${PATH_ESCAPE_EXIT} ;; esac`,
		`tmp=$(mktemp -- "$dir/${hiddenFileName("upload")}.XXXXXX")`,
		"trap 'rm -f -- \"$tmp\"' EXIT",
		'cat > "$tmp"',
		`chmod ${mode} -- "$tmp"`,
		'mv -fT -- "$tmp" "$target"',
		"trap - EXIT",
	].join("\n");
}

/**
 * Shell script that prints `target` as base64, refusing symlinks anywhere
 * in the path (the resolved path must equal the requested one).
 */
export function managedReadScript(target: string): string {
	const path = assertManagedPath(target);
	const q = shellQuote;
	return [
		"set -e",
		`target=${q(path)}`,
		`[ "$(realpath -e -- "$target")" = "$target" ] || { echo "Refusing to read through a symlink: $target" >&2; exit ${PATH_ESCAPE_EXIT}; }`,
		'[ -f "$target" ] || { echo "Not a regular file: $target" >&2; exit 1; }',
		'base64 < "$target"',
	].join("\n");
}

type ExecFn = (command: string, options?: ExecOptions) => Promise<ExecResult>;

export async function writeManagedFile(
	exec: ExecFn,
	content: string | Buffer,
	target: string,
	mode?: string,
): Promise<void> {
	if (mode !== undefined && !/^0?[0-7]{3}$/.test(mode)) {
		throw internalError(`Invalid file mode ${mode}`);
	}
	const result = await exec(managedWriteScript(target, mode), {
		input: content,
	});
	if (result.exitCode !== 0) {
		throw new AppError("FILE_WRITE_FAILED", {
			path: target,
			detail: result.stderr,
		});
	}
}

export async function readManagedFile(
	exec: ExecFn,
	target: string,
): Promise<string> {
	const result = await exec(managedReadScript(target));
	if (result.exitCode !== 0) {
		throw new AppError("FILE_READ_FAILED", {
			path: target,
			detail: result.stderr,
		});
	}
	// base64 keeps leading/trailing whitespace intact through output trimming.
	return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString(
		"utf8",
	);
}

/**
 * Wrap a remote command so a timeout kills its whole process tree: GNU
 * `timeout` runs the command in its own process group and signals the
 * group. `tag` is embedded in the argv (`: nitrobase-job-<tag>`) so the tree
 * can be found and killed from another channel: OpenSSH refuses channel
 * signal requests for root sessions ("requires privilege separation").
 */
export function withRemoteTimeout(
	command: string,
	timeoutMs: number,
	tag?: string,
): string {
	const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
	const marker = tag ? `: ${jobMarker(tag)}; ` : "";
	const quoted = shellQuote(`${marker}${command}`);
	return `if command -v timeout >/dev/null 2>&1; then exec timeout --kill-after=10s ${seconds}s sh -c ${quoted}; else exec sh -c ${quoted}; fi`;
}

function jobMarker(tag: string): string {
	if (!/^[a-z0-9]{8,32}$/.test(tag)) throw internalError("Invalid job tag");
	return resourceName(`job-${tag}`);
}

/** Kill every process whose argv carries the job marker (timeout + sh). */
export function killTaggedCommand(
	tag: string,
	signal: "TERM" | "KILL",
): string {
	return `pkill -${signal} -f ${shellQuote(jobMarker(tag))} || true`;
}
