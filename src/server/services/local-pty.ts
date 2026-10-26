import { APP_ID } from "#/config/shared.ts";
import { internalError } from "#/utils/error.ts";

/**
 * Window size for the local shell. The local terminal runs under `script`
 * (util-linux), which allocates a PTY from piped stdio but cannot be told
 * a new size. Instead the shell reports its PTY path once, in a private OSC
 * sequence that is stripped from the output, and a resize runs
 * `stty -F <pty> rows R cols C` as a separate process: the kernel updates
 * the size and sends SIGWINCH to the foreground job, exactly like a real
 * terminal resize. Nothing is typed into the user's shell.
 *
 * Chosen over node-pty (native addon: needs python/make/g++ in the alpine
 * image) and Bun's PTY API (not in the pinned Bun, and `vite dev` runs on
 * Node).
 */

const MARKER_START = `\x1b]697;${APP_ID}-tty=`;
const MARKER_END = "\x07";
/** Longest marker we wait for before giving up (path is short). */
const MARKER_MAX = MARKER_START.length + 64;
const PTY_PATH = /^\/dev\/pts\/\d+$/;

/**
 * Shell snippet run inside the PTY: announce the PTY path, apply the
 * initial size, then run `command`.
 */
export function ptyBootstrap(command: string, rows: number, cols: number) {
	return `printf '\\033]697;${APP_ID}-tty=%s\\007' "$(tty)"; stty rows ${rows} cols ${cols}; ${command}`;
}

/** `stty` command resizing the PTY at `path` (validated). */
export function resizeCommand(path: string, rows: number, cols: number) {
	if (!PTY_PATH.test(path)) throw internalError("Invalid PTY path");
	return `stty -F ${path} rows ${Math.trunc(rows)} cols ${Math.trunc(cols)}`;
}

/**
 * Pulls the PTY marker off the start of the shell output. Feed every
 * decoded chunk through `push`; it returns the text to show. The marker is
 * only accepted at the very start of the output, so programs printing a
 * look-alike later can't redirect resizes.
 */
export class PtyMarkerReader {
	private buffer = "";
	private done = false;
	path: string | null = null;

	push(text: string): string {
		if (this.done) return text;
		this.buffer += text;
		if (!MARKER_START.startsWith(this.buffer.slice(0, MARKER_START.length))) {
			return this.finish();
		}
		const end = this.buffer.indexOf(MARKER_END, MARKER_START.length);
		if (end === -1) {
			return this.buffer.length > MARKER_MAX ? this.finish() : "";
		}
		const path = this.buffer.slice(MARKER_START.length, end);
		if (PTY_PATH.test(path)) this.path = path;
		this.buffer = this.buffer.slice(end + MARKER_END.length);
		return this.finish();
	}

	private finish(): string {
		this.done = true;
		const rest = this.buffer;
		this.buffer = "";
		return rest;
	}
}

/**
 * Serializes resizes so they apply in order and only the latest pending
 * size runs (dragging a window fires many).
 */
export function createResizer(
	run: (rows: number, cols: number) => Promise<unknown>,
) {
	let running = false;
	let pending: { rows: number; cols: number } | null = null;
	const drain = async () => {
		running = true;
		while (pending) {
			const next = pending;
			pending = null;
			try {
				await run(next.rows, next.cols);
			} catch {
				// A failed resize only leaves the previous size.
			}
		}
		running = false;
	};
	return (rows: number, cols: number) => {
		pending = { rows, cols };
		if (!running) void drain();
	};
}
