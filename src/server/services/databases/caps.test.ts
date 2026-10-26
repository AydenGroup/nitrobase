import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { capped, parseCappedOutput } = await import("./console");
const { runCapped } = await import("./exec");

const nonce = "0123456789abcdef0123456789abcdef";
const limits = { timeoutMs: 5000, maxBytes: 4096, maxErrorBytes: 2048 };

/** Run a `capped` script with the local POSIX sh. */
function sh(command: string) {
	const result = spawnSync("sh", ["-c", capped(command, nonce, limits)], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status,
	};
}

describe("capped (real sh)", () => {
	it("caps a NOTICE flood on stderr, keeps its end, the client finishes with its status", () => {
		const run = sh(
			`yes 'NOTICE:  flood' | head -c 2000000 >&2; echo result; sh -c 'echo ERROR: boom >&2; exit 3'`,
		);
		expect(Buffer.byteLength(run.stderr)).toBeLessThanOrEqual(2048);
		expect(run.stderr.endsWith("ERROR: boom\n")).toBe(true);
		const out = parseCappedOutput(run.stdout, nonce);
		expect(out).toMatchObject({
			body: "result\n",
			exitCode: 3,
			truncated: false,
		});
	});

	it("cuts a huge result and reports it as cut off", () => {
		const run = sh(`yes 'row,row' | head -c 5000000`);
		expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(4096);
		expect(parseCappedOutput(run.stdout, nonce).truncated).toBe(true);
	});

	it("passes small output and the exit status through", () => {
		const run = sh(`echo a,b; echo 1,2; echo oops >&2; sh -c 'exit 0'`);
		expect(run.stderr).toBe("oops\n");
		expect(parseCappedOutput(run.stdout, nonce)).toEqual({
			body: "a,b\n1,2\n",
			exitCode: 0,
			truncated: false,
		});
	});
});

describe("runCapped (fake executor)", () => {
	it("never keeps more than the limits, whatever the executor streams", async () => {
		const exec = vi.fn(
			async (
				_command: string,
				options: {
					discardOutput?: boolean;
					onStdout?: (chunk: string) => void;
					onStderr?: (chunk: string) => void;
				},
			) => {
				expect(options.discardOutput).toBe(true);
				for (let i = 0; i < 1000; i++) {
					options.onStdout?.("x".repeat(10_000));
					options.onStderr?.("NOTICE ".repeat(1000));
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		);
		const result = await runCapped({ exec } as never, "cmd", {
			timeoutMs: 1000,
			nonce,
			limits,
		});
		expect(result.body.length).toBeLessThanOrEqual(4096 + 256);
		expect(result.stderr.length).toBeLessThanOrEqual(2048);
		expect(result.truncated).toBe(true);
		expect(result.exitCode).toBeNull();
	});

	it("parses the marker of a normal run", async () => {
		const exec = async (
			_command: string,
			options: {
				onStdout?: (chunk: string) => void;
				onStderr?: (chunk: string) => void;
			},
		) => {
			options.onStdout?.(`ok\n\n__nitrobase_exit_${nonce}__:0\n`);
			options.onStderr?.("warning\n");
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		const result = await runCapped({ exec } as never, "cmd", {
			timeoutMs: 1000,
			nonce,
			limits,
		});
		expect(result).toEqual({
			body: "ok\n",
			exitCode: 0,
			truncated: false,
			stderr: "warning\n",
		});
	});
});
