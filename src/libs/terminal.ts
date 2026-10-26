import { internalError } from "#/utils/error.ts";
/** Bounds applied to client-supplied PTY sizes before resizing the remote shell. */
export const MIN_COLS = 10;
export const MAX_COLS = 500;
export const MIN_ROWS = 5;
export const MAX_ROWS = 200;
/** PTY size used until the client reports its own. */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
/**
 * Largest client frame the server accepts, measured in UTF-16 code units of
 * the frame text (`string.length`). Larger frames are rejected with a
 * visible notice; the client splits input with `chunkTerminalInput` so a
 * paste never reaches this limit.
 */
export const MAX_INPUT_BYTES = 4 * 1024;

/**
 * Truncates `value` to an integer within [min, max]; non-numeric or
 * non-finite input falls back to `fallback` (which is then clamped too).
 */
export function clampInt(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
) {
	const n =
		typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.max(min, Math.min(Math.trunc(n), max));
}

/** A decoded client frame from the terminal WebSocket. */
export type TerminalMessage =
	| { kind: "input"; data: string }
	| { kind: "resize"; rows: number; cols: number }
	| { kind: "raw"; data: string }
	/** Frame over `MAX_INPUT_BYTES`: dropped, and the user is told so. */
	| { kind: "rejected"; size: number };

/**
 * Decodes one client WebSocket frame. JSON `{type:"input"}` and
 * `{type:"resize"}` frames are recognized; any other valid JSON is ignored
 * (null), non-JSON text is passed through as raw keystrokes, and frames over
 * `MAX_INPUT_BYTES` come back as `rejected` so the caller can say so.
 */
export function parseTerminalMessage(text: string): TerminalMessage | null {
	if (text.length > MAX_INPUT_BYTES) {
		return { kind: "rejected", size: text.length };
	}

	try {
		const parsed = JSON.parse(text) as
			| { type: "input"; data?: string }
			| { type: "resize"; cols?: number; rows?: number };
		if (parsed?.type === "input" && typeof parsed.data === "string") {
			return { kind: "input", data: parsed.data };
		}
		if (parsed?.type === "resize") {
			return {
				kind: "resize",
				rows: clampInt(parsed.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS),
				cols: clampInt(parsed.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS),
			};
		}
		return null;
	} catch {
		// Non-JSON text → direct terminal input.
		return { kind: "raw", data: text };
	}
}

/** Encoded `{type:"input"}` frame for `data` (the client wire format). */
function inputFrame(data: string): string {
	return JSON.stringify({ type: "input", data });
}

/**
 * Splits terminal input (e.g. a large paste) into `{type:"input"}` frames
 * that each stay within `maxFrame` code units once JSON-encoded. Sent in
 * order over one WebSocket they arrive in order, so the shell sees the
 * original text. Surrogate pairs are never split; JSON escaping (control
 * characters expand up to 6x) is accounted for per character.
 */
export function chunkTerminalInput(
	data: string,
	maxFrame = MAX_INPUT_BYTES,
): string[] {
	const envelope = inputFrame("").length;
	const budget = maxFrame - envelope;
	if (budget < 12) throw internalError("maxFrame too small for one character");
	if (data.length + envelope <= maxFrame) {
		const frame = inputFrame(data);
		if (frame.length <= maxFrame) return [frame];
	}
	const frames: string[] = [];
	let start = 0;
	let used = 0;
	let index = 0;
	while (index < data.length) {
		const code = data.charCodeAt(index);
		const pair =
			code >= 0xd800 && code <= 0xdbff && index + 1 < data.length ? 2 : 1;
		// Encoded size of this character inside a JSON string.
		const cost = pair === 2 ? 2 : JSON.stringify(data[index]).length - 2;
		if (used + cost > budget) {
			frames.push(inputFrame(data.slice(start, index)));
			start = index;
			used = 0;
		}
		used += cost;
		index += pair;
	}
	if (start < data.length) frames.push(inputFrame(data.slice(start)));
	return frames;
}

/**
 * Guard against cross-site WebSocket hijacking: browsers always send Origin
 * on WebSocket upgrades and pages can't forge it, so the Origin host must
 * match the Host (or proxy-set X-Forwarded-Host) the request was sent to.
 */
export function isSameOriginUpgrade(headers: Headers): boolean {
	const origin = headers.get("origin");
	if (!origin) return false;
	let originHost: string;
	try {
		originHost = new URL(origin).host.toLowerCase();
	} catch {
		return false;
	}
	const hosts = [headers.get("host"), headers.get("x-forwarded-host")]
		.flatMap((value) => value?.split(",") ?? [])
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	return hosts.includes(originHost);
}
