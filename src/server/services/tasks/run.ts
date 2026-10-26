import type { TaskCommand } from "#/db/schema/tasks.ts";
import type { Executor } from "#/server/services/executor.ts";
import { AppError } from "#/utils/error.ts";
import {
	imageIdCommand,
	parseShellProbe,
	shellProbeCommand,
	taskExecCommand,
} from "./commands";

/**
 * Run a task's command once inside its container. Output is streamed to
 * `onOutput` and never buffered by the executor (`discardOutput`): a task
 * printing without end must not grow the panel's memory. Whether the image
 * has `sh` (wrapped vs plain argv) is decided before the run and cached
 * per image id, so nothing is ever run twice.
 */
export interface TaskRunInput {
	container: string;
	command: TaskCommand;
	timeoutSeconds: number;
	onOutput: (chunk: string) => void;
	signal?: AbortSignal;
}

export type ShellCache = Map<string, boolean>;

const globalCache = globalThis as typeof globalThis & {
	__nitrobaseTaskShellCache?: ShellCache;
};
globalCache.__nitrobaseTaskShellCache ??= new Map();

function isTimeout(error: unknown): boolean {
	return error instanceof AppError && error.code === "COMMAND_TIMEOUT";
}

/** Whether `sh` starts in the container's image (cached per image id). */
async function imageHasShell(
	executor: Pick<Executor, "exec">,
	container: string,
	cache: ShellCache = globalCache.__nitrobaseTaskShellCache as ShellCache,
): Promise<boolean> {
	const image = (await executor.exec(imageIdCommand(container))).stdout.trim();
	const cached = image ? cache.get(image) : undefined;
	if (cached !== undefined) return cached;
	const probe = await executor.exec(shellProbeCommand(container));
	const hasShell = parseShellProbe(probe.stdout);
	if (image) cache.set(image, hasShell);
	return hasShell;
}

export async function runTaskCommand(
	executor: Pick<Executor, "exec">,
	input: TaskRunInput,
	cache?: ShellCache,
): Promise<{ exitCode: number; timedOut: boolean; wrapped: boolean }> {
	const wrapped = await imageHasShell(executor, input.container, cache);
	try {
		const result = await executor.exec(
			taskExecCommand(input.container, input.command, input.timeoutSeconds, {
				wrapped,
			}),
			{
				// The in-container timeout (wrapped) fires first; this one
				// bounds the docker client.
				timeoutMs: (input.timeoutSeconds + 15) * 1000,
				signal: input.signal,
				onStdout: input.onOutput,
				onStderr: input.onOutput,
				discardOutput: true,
			},
		);
		return { exitCode: result.exitCode, timedOut: false, wrapped };
	} catch (error) {
		if (!isTimeout(error)) throw error;
		return { exitCode: 137, timedOut: true, wrapped };
	}
}
