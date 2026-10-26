import type { TaskCommand } from "#/db/schema/tasks.ts";
import {
	TASK_ARG_MAX_LENGTH,
	TASK_ARGV_MAX,
	TASK_SHELL_MAX_LENGTH,
} from "#/features/tasks/schema.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { internalError } from "#/utils/error.ts";

/**
 * Commands of scheduled tasks (M8). A task always runs *inside* a service
 * container through `docker exec`, never on the host:
 * - `argv`: the program and its arguments, each one quoted word of the
 *   host's `docker exec` call (nothing is interpolated by a shell);
 * - `shell`: the argv `sh -c <script>`, the script one argument (data).
 * Both go through a positional wrapper that adds an in-container
 * `timeout` when the image has one; images without `sh` fall back to the
 * plain argv (then only the host-side timeout applies).
 * Pure (tested).
 */

export type TaskCommandProblem =
	| "both_or_none"
	| "argv_count"
	| "empty_program"
	| "too_long"
	| "nul";

export class TaskCommandError extends Error {
	constructor(readonly problem: TaskCommandProblem) {
		super(`Invalid task command (${problem})`);
	}
}

const CONTAINER = /^[a-z0-9][a-z0-9_.-]*$/;

export function assertTaskCommand(command: TaskCommand): TaskCommand {
	const hasArgv = Array.isArray(command.argv);
	const hasShell = typeof command.shell === "string";
	if (hasArgv === hasShell) throw new TaskCommandError("both_or_none");
	if (hasArgv) {
		const argv = command.argv as string[];
		if (argv.length === 0 || argv.length > TASK_ARGV_MAX) {
			throw new TaskCommandError("argv_count");
		}
		if (!argv[0]?.trim()) throw new TaskCommandError("empty_program");
		for (const arg of argv) {
			if (arg.length > TASK_ARG_MAX_LENGTH)
				throw new TaskCommandError("too_long");
			if (arg.includes("\0")) throw new TaskCommandError("nul");
		}
		return { argv };
	}
	const shell = command.shell as string;
	if (!shell.trim()) throw new TaskCommandError("empty_program");
	if (shell.length > TASK_SHELL_MAX_LENGTH)
		throw new TaskCommandError("too_long");
	if (shell.includes("\0")) throw new TaskCommandError("nul");
	return { shell };
}

/** The argv a task runs in the container. */
function taskArgv(command: TaskCommand): string[] {
	const valid = assertTaskCommand(command);
	return valid.argv ?? ["sh", "-c", valid.shell as string];
}

/** In-container timeout when available; "$0" = seconds, "$@" = argv. */
const TIMEOUT_WRAPPER =
	'if command -v timeout >/dev/null 2>&1; then exec timeout -k 10 "$0" "$@"; fi; exec "$@"';

/**
 * `docker exec` of a task. `wrapped` (default) runs it through the
 * positional timeout wrapper (needs `sh` in the image); `false` execs the
 * argv directly (images without `sh`).
 */
export function taskExecCommand(
	container: string,
	command: TaskCommand,
	timeoutSeconds: number,
	options: { wrapped?: boolean } = {},
): string {
	if (!CONTAINER.test(container)) throw internalError("Invalid container name");
	const argv = taskArgv(command).map(q);
	const seconds = Math.max(1, Math.floor(timeoutSeconds));
	return options.wrapped === false
		? ["docker exec", q(container), ...argv].join(" ")
		: [
				"docker exec",
				q(container),
				"sh -c",
				q(TIMEOUT_WRAPPER),
				String(seconds),
				...argv,
			].join(" ");
}

/**
 * Before a run: the container's image id and whether `sh` can start in it
 * (`docker exec C sh -c true`). Probed once per image id (cached by the
 * caller); the command then runs exactly once, wrapped or plain.
 */
export function imageIdCommand(container: string): string {
	if (!CONTAINER.test(container)) throw internalError("Invalid container name");
	return `docker inspect -f '{{.Image}}' ${q(container)}`;
}

export function shellProbeCommand(container: string): string {
	if (!CONTAINER.test(container)) throw internalError("Invalid container name");
	return `docker exec ${q(container)} sh -c true >/dev/null 2>&1; echo "sh=$?"`;
}

/**
 * `sh` is missing when the exec itself fails to start it (126/127, OCI
 * "executable file not found"); any other result (0, or the container
 * being stopped) keeps the wrapped form.
 */
export function parseShellProbe(output: string): boolean {
	const code = Number(output.match(/sh=(\d+)/)?.[1]);
	return !(code === 126 || code === 127);
}

/**
 * OOM-kill counter of the container's cgroup (v2 `memory.events`), else
 * `-` plus Docker's sticky OOMKilled flag. Read before and after a run: a
 * kill during the run raises the counter (the flag alone stays true after
 * any earlier OOM until the container restarts).
 */
export function oomStateCommand(container: string): string {
	if (!CONTAINER.test(container)) throw internalError("Invalid container name");
	const c = q(container);
	return `n=$(docker exec ${c} cat /sys/fs/cgroup/memory.events 2>/dev/null | awk '/^oom_kill /{print $2}'); printf '%s %s\\n' "\${n:-x}" "$(docker inspect -f '{{.State.OOMKilled}}' ${c} 2>/dev/null)"`;
}

/** Whether an OOM kill happened between two `oomStateCommand` readings. */
export function oomDuringRun(before: string, after: string): boolean {
	// "<count> <flag>", count "x" when cgroup v2 is unavailable.
	const parse = (text: string) => text.trim().split(/\s+/);
	const [countBefore, flagBefore] = parse(before);
	const [countAfter, flagAfter] = parse(after);
	const a = Number(countBefore);
	const b = Number(countAfter);
	if (countBefore && countAfter && Number.isFinite(a) && Number.isFinite(b)) {
		return b > a;
	}
	return flagBefore !== "true" && flagAfter === "true";
}

export type TaskEnding =
	| { status: "success" }
	| { status: "timeout" }
	| { status: "oom" }
	| { status: "killed"; signal: number }
	| { status: "failed"; exitCode: number };

/**
 * Classify how a run ended. Timeout: the host-side timeout fired, GNU
 * `timeout` exited 124, or (busybox `timeout`) a signal ended a run that
 * lasted the whole timeout (`overran`).
 */
export function classifyExit(
	exitCode: number,
	options: { oomKilled: boolean; timedOut: boolean; overran?: boolean },
): TaskEnding {
	if (exitCode === 0) return { status: "success" };
	if (options.oomKilled) return { status: "oom" };
	if (
		options.timedOut ||
		exitCode === 124 ||
		(options.overran && exitCode > 128 && exitCode < 160)
	) {
		return { status: "timeout" };
	}
	if (exitCode > 128 && exitCode < 160) {
		return { status: "killed", signal: exitCode - 128 };
	}
	return { status: "failed", exitCode };
}

/** Keep the last `max` characters of output. */
export function appendTail(
	current: string,
	chunk: string,
	max: number,
): string {
	const next = current + chunk;
	return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Replace the app's secret values in output. Lines are masked whole, so a
 * secret split across two chunks is still caught (`flush` at the end).
 */
export function createSecretMasker(secrets: string[]): {
	push(chunk: string): string;
	flush(): string;
} {
	const values = [
		...new Set(secrets.filter((value) => value.length >= 6)),
	].sort((a, b) => b.length - a.length);
	const apply = (text: string) =>
		values.reduce((out, value) => out.split(value).join("••••••"), text);
	let pending = "";
	return {
		push(chunk) {
			const text = pending + chunk;
			const end = text.lastIndexOf("\n");
			if (end < 0) {
				// A very long line without a newline is masked as it is.
				if (text.length > 8192) {
					pending = "";
					return apply(text);
				}
				pending = text;
				return "";
			}
			pending = text.slice(end + 1);
			return apply(text.slice(0, end + 1));
		},
		flush() {
			const rest = apply(pending);
			pending = "";
			return rest;
		},
	};
}
