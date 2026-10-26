import { describe, expect, it } from "vitest";
import {
	appendTail,
	assertTaskCommand,
	classifyExit,
	createSecretMasker,
	oomDuringRun,
	TaskCommandError,
	taskExecCommand,
} from "./commands";

describe("task commands", () => {
	it("passes argv as quoted words through the positional timeout wrapper", () => {
		const command = taskExecCommand(
			"app-1234abcd-web",
			{ argv: ["php", "artisan", "x; rm -rf /"] },
			60,
		);
		expect(command).toBe(
			`docker exec 'app-1234abcd-web' sh -c 'if command -v timeout >/dev/null 2>&1; then exec timeout -k 10 "$0" "$@"; fi; exec "$@"' 60 'php' 'artisan' 'x; rm -rf /'`,
		);
		// Images without sh: the plain argv.
		expect(
			taskExecCommand("app-1234abcd-web", { argv: ["/app", "run"] }, 60, {
				wrapped: false,
			}),
		).toBe("docker exec 'app-1234abcd-web' '/app' 'run'");
	});

	it("runs a shell script as `sh -c <script>`, the script one argument", () => {
		const command = taskExecCommand(
			"app-1234abcd-web",
			{ shell: "echo $HOME && echo 'quoted'" },
			300,
		);
		expect(
			command.endsWith(` 300 'sh' '-c' 'echo $HOME && echo '\\''quoted'\\'''`),
		).toBe(true);
	});

	it("rejects bad commands with a reason", () => {
		const problem = (command: Parameters<typeof assertTaskCommand>[0]) => {
			try {
				assertTaskCommand(command);
				return null;
			} catch (error) {
				return error instanceof TaskCommandError ? error.problem : "other";
			}
		};
		expect(problem({})).toBe("both_or_none");
		expect(problem({ argv: [] })).toBe("argv_count");
		expect(problem({ argv: [" "] })).toBe("empty_program");
		expect(problem({ shell: "  " })).toBe("empty_program");
		expect(problem({ argv: ["a\0b"] })).toBe("nul");
		expect(problem({ shell: "x".repeat(20_000) })).toBe("too_long");
		expect(() => taskExecCommand("x; rm", { argv: ["ls"] }, 1)).toThrow();
	});

	it("tells timeout, OOM and signals apart", () => {
		expect(classifyExit(0, { oomKilled: false, timedOut: false })).toEqual({
			status: "success",
		});
		expect(
			classifyExit(124, { oomKilled: false, timedOut: false }).status,
		).toBe("timeout");
		expect(classifyExit(137, { oomKilled: true, timedOut: false }).status).toBe(
			"oom",
		);
		expect(
			classifyExit(143, { oomKilled: false, timedOut: false, overran: true })
				.status,
		).toBe("timeout");
		expect(classifyExit(137, { oomKilled: false, timedOut: false })).toEqual({
			status: "killed",
			signal: 9,
		});
		expect(classifyExit(2, { oomKilled: false, timedOut: false })).toEqual({
			status: "failed",
			exitCode: 2,
		});
	});

	it("detects an OOM kill during the run, not an earlier one", () => {
		expect(oomDuringRun("1 true", "1 true")).toBe(false);
		expect(oomDuringRun("1 true", "2 true")).toBe(true);
		expect(oomDuringRun("x false", "x true")).toBe(true);
		expect(oomDuringRun("x true", "x true")).toBe(false);
	});

	it("masks secrets even when split across chunks", () => {
		const masker = createSecretMasker(["s3cr3t-value", "short"]);
		const out =
			masker.push("token=s3cr3t-") +
			masker.push("value ok\nshort stays\n") +
			masker.flush();
		expect(out).toBe("token=•••••• ok\nshort stays\n");
	});

	it("keeps only the tail of the output", () => {
		expect(appendTail("abc", "def", 4)).toBe("cdef");
		expect(appendTail("", "ab", 4)).toBe("ab");
	});
});
