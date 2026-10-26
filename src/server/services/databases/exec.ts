import type { Executor } from "#/server/services/executor.ts";
import {
	type ConsoleLimits,
	type ConsoleOutput,
	parseCappedOutput,
} from "./console";

/**
 * Run a command built with `capped` (console, admin SQL, console login
 * setup) without the executor buffering anything (`discardOutput`): output
 * is collected here up to the limits, on top of the caps applied inside
 * the container. Pure apart from the executor (tested with a fake one).
 */
export interface CappedRun extends ConsoleOutput {
	/** First `maxErrorBytes` of the error output. */
	stderr: string;
}

/** Bytes kept beyond the limits for the exit marker line. */
const MARKER_SLACK = 256;

function collector(max: number) {
	let text = "";
	let bytes = 0;
	let over = false;
	return {
		push(chunk: string) {
			if (over) return;
			const size = Buffer.byteLength(chunk, "utf8");
			if (bytes + size > max) {
				text += Buffer.from(chunk, "utf8")
					.subarray(0, Math.max(0, max - bytes))
					.toString("utf8");
				bytes = max;
				over = true;
				return;
			}
			text += chunk;
			bytes += size;
		},
		get text() {
			return text;
		},
		get over() {
			return over;
		},
	};
}

export async function runCapped(
	executor: Executor,
	command: string,
	options: {
		input?: string;
		timeoutMs: number;
		nonce: string;
		limits: Pick<ConsoleLimits, "maxBytes" | "maxErrorBytes">;
	},
): Promise<CappedRun> {
	const out = collector(options.limits.maxBytes + MARKER_SLACK);
	const err = collector(options.limits.maxErrorBytes);
	await executor.exec(command, {
		input: options.input,
		timeoutMs: options.timeoutMs,
		discardOutput: true,
		onStdout: (chunk) => out.push(chunk),
		onStderr: (chunk) => err.push(chunk),
	});
	const parsed = parseCappedOutput(out.text, options.nonce);
	return {
		...parsed,
		truncated: parsed.truncated || out.over,
		stderr: err.text,
	};
}
