import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult } from "#/server/services/executor.ts";
import { parseShellProbe } from "./commands";
import { runTaskCommand, type ShellCache } from "./run";

/**
 * Fake executor with the real executors' buffering rule: output is kept
 * in the result unless `discardOutput` (see local.ts / ssh.ts).
 */
function fakeExecutor(script: {
	image?: string;
	probe?: string;
	run: { chunks: number; chunk: string; stderr?: string; exitCode: number };
}) {
	const calls: { command: string; options?: ExecOptions }[] = [];
	const exec = async (
		command: string,
		options?: ExecOptions,
	): Promise<ExecResult> => {
		calls.push({ command, options });
		if (command.startsWith("docker inspect")) {
			return { stdout: script.image ?? "sha256:img", stderr: "", exitCode: 0 };
		}
		if (command.includes("sh -c true")) {
			return { stdout: script.probe ?? "sh=0", stderr: "", exitCode: 0 };
		}
		let stdout = "";
		let stderr = "";
		for (let i = 0; i < script.run.chunks; i++) {
			options?.onStdout?.(script.run.chunk);
			if (!options?.discardOutput) stdout += script.run.chunk;
		}
		if (script.run.stderr) {
			options?.onStderr?.(script.run.stderr);
			if (!options?.discardOutput) stderr += script.run.stderr;
		}
		return { stdout, stderr, exitCode: script.run.exitCode };
	};
	return { exec, calls };
}

describe("runTaskCommand", () => {
	it("streams a huge output without the executor buffering it", async () => {
		const executor = fakeExecutor({
			run: { chunks: 10_000, chunk: `${"y\n".repeat(512)}`, exitCode: 0 },
		});
		let seen = 0;
		const result = await runTaskCommand(
			executor,
			{
				container: "app-1234abcd-web",
				command: { argv: ["yes"] },
				timeoutSeconds: 60,
				onOutput: (chunk) => {
					seen += chunk.length;
				},
			},
			new Map(),
		);
		expect(result.exitCode).toBe(0);
		expect(seen).toBe(10_000 * 1024);
		const run = executor.calls.at(-1);
		expect(run?.options?.discardOutput).toBe(true);
	});

	it("never runs the command twice, even on a bash-style exit 127", async () => {
		const executor = fakeExecutor({
			run: {
				chunks: 0,
				chunk: "",
				stderr: "sh: line 1: ./x: No such file or directory\n",
				exitCode: 127,
			},
		});
		const result = await runTaskCommand(
			executor,
			{
				container: "app-1234abcd-web",
				command: { shell: "./x" },
				timeoutSeconds: 60,
				onOutput: () => {},
			},
			new Map(),
		);
		expect(result.exitCode).toBe(127);
		const runs = executor.calls.filter((call) =>
			call.command.includes("timeout -k"),
		);
		expect(runs).toHaveLength(1);
	});

	it("probes sh once per image and runs plain argv without it", async () => {
		const cache: ShellCache = new Map();
		const input = {
			container: "app-1234abcd-web",
			command: { argv: ["/app", "migrate"] },
			timeoutSeconds: 30,
			onOutput: () => {},
		};
		const first = fakeExecutor({
			probe: "sh=127",
			run: { chunks: 0, chunk: "", exitCode: 0 },
		});
		expect((await runTaskCommand(first, input, cache)).wrapped).toBe(false);
		expect(first.calls.at(-1)?.command).toBe(
			"docker exec 'app-1234abcd-web' '/app' 'migrate'",
		);
		const second = fakeExecutor({ run: { chunks: 0, chunk: "", exitCode: 0 } });
		await runTaskCommand(second, input, cache);
		expect(
			second.calls.some((call) => call.command.includes("sh -c true")),
		).toBe(false);
		expect(parseShellProbe("sh=0")).toBe(true);
		expect(parseShellProbe("sh=1")).toBe(true);
		expect(parseShellProbe("sh=126")).toBe(false);
	});
});
