import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { getConfig } from "#/config/server.ts";
import { AppError } from "#/utils/error.ts";
import {
	clampTerminalSize,
	commandTimeoutMs,
	type ExecOptions,
	type ExecResult,
	type Executor,
	type OpenShellOptions,
	readManagedFile,
	type ShellSession,
	writeManagedFile,
} from "./executor";
import {
	createResizer,
	PtyMarkerReader,
	ptyBootstrap,
	resizeCommand,
} from "./local-pty";

/** Markers of a container runtime in /proc/1/cgroup (cgroup v1). */
const CONTAINER_CGROUP = /docker|containerd|kubepods|libpod|lxc/;
/** Container-managed files mounted into the root fs (cgroup v2 hosts). */
const CONTAINER_MOUNTINFO =
	/\/(docker|containerd|libpod)\/.*\/(hostname|resolv\.conf|hosts)\s/;

function detectContainer(): boolean {
	if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) {
		return true;
	}
	try {
		if (CONTAINER_CGROUP.test(readFileSync("/proc/1/cgroup", "utf8"))) {
			return true;
		}
	} catch {
		// not Linux
	}
	try {
		// cgroup v2 shows only "0::/" in a container; the bind-mounted
		// /etc/hostname from the runtime's state dir still gives it away.
		return CONTAINER_MOUNTINFO.test(
			readFileSync("/proc/self/mountinfo", "utf8"),
		);
	} catch {
		return false;
	}
}

let containerized: boolean | null = null;

/**
 * True when this process runs inside a container, so host commands must go
 * through nsenter. `LOCAL_EXEC_MODE` overrides detection; the result is
 * computed once per process.
 */
export function isInContainer(): boolean {
	if (containerized !== null) return containerized;
	const mode = getConfig().LOCAL_EXEC_MODE;
	containerized = mode === "auto" ? detectContainer() : mode === "container";
	return containerized;
}

/**
 * Whether the local shell gets a real PTY: `script` provides one on Linux
 * (host or container); the macOS dev fallback is a plain piped shell.
 */
export function hasLocalPty(): boolean {
	return isInContainer() || process.platform !== "darwin";
}

const NSENTER_HOST = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--"];

/**
 * Minimal environment for host commands so app secrets (ENCRYPTION_KEY,
 * SESSION_SECRET, DATABASE_URL, ...) never leak into shells or scripts.
 */
function hostEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
	const container = isInContainer();
	const env: Record<string, string> = {
		PATH: container
			? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
			: (process.env.PATH ?? "/usr/bin:/bin"),
		HOME: container ? "/root" : (process.env.HOME ?? "/"),
		LANG: process.env.LANG ?? "C.UTF-8",
		...(!container && process.env.USER && { USER: process.env.USER }),
		...(!container &&
			process.env.DOCKER_HOST && { DOCKER_HOST: process.env.DOCKER_HOST }),
		...extra,
	};
	// ProcessEnv is augmented with required app vars; the host gets none.
	return env as unknown as NodeJS.ProcessEnv;
}

/**
 * Execute a trusted command on the host (via nsenter when containerized).
 */
function execHost(command: string, options?: ExecOptions): Promise<ExecResult> {
	const argv = isInContainer()
		? [...NSENTER_HOST, "sh", "-c", command]
		: ["sh", "-c", command];

	return new Promise((resolve, reject) => {
		const proc = spawn(argv[0], argv.slice(1), {
			stdio: [options?.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
			env: hostEnv(),
			// Own process group so a timeout kills the whole tree, not just nsenter.
			detached: true,
		});
		const timeoutMs = options?.timeoutMs ?? commandTimeoutMs();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (proc.pid) process.kill(-proc.pid, "SIGKILL");
			} catch {
				proc.kill("SIGKILL");
			}
		}, timeoutMs);
		const outDecoder = new StringDecoder("utf8");
		const errDecoder = new StringDecoder("utf8");
		let stdout = "";
		let stderr = "";

		options?.onFlowControl?.({
			pause: () => proc.stdout?.pause(),
			resume: () => proc.stdout?.resume(),
		});
		proc.stdout?.on("data", (data: Buffer) => {
			options?.onStdoutData?.(data);
			if (options?.onStdoutData && options.discardOutput) return;
			const text = outDecoder.write(data);
			if (!options?.discardOutput) stdout += text;
			if (text) options?.onStdout?.(text);
		});
		proc.stderr?.on("data", (data: Buffer) => {
			const text = errDecoder.write(data);
			if (!options?.discardOutput) stderr += text;
			if (text) options?.onStderr?.(text);
		});
		const killGroup = (signal: NodeJS.Signals) => {
			try {
				if (proc.pid) process.kill(-proc.pid, signal);
			} catch {
				proc.kill(signal);
			}
		};
		const onAbort = () => {
			// Resume a paused stdout (backpressure) so the writer sees the end.
			proc.stdout?.resume();
			killGroup("SIGTERM");
			setTimeout(() => {
				if (proc.exitCode === null) killGroup("SIGKILL");
			}, getConfig().PROCESS_KILL_GRACE_MS).unref();
		};
		if (options?.signal?.aborted) onAbort();
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		proc.on("close", (code) => {
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", onAbort);
			if (timedOut) {
				reject(
					new AppError("COMMAND_TIMEOUT", { duration: { $ms: timeoutMs } }),
				);
				return;
			}
			stdout += outDecoder.end();
			stderr += errDecoder.end();
			resolve({
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				exitCode: code ?? (options?.signal?.aborted ? 130 : 1),
			});
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		if (options?.input !== undefined && proc.stdin) {
			proc.stdin.end(options.input);
		}
	});
}

/**
 * Open an interactive shell on the host (through nsenter when containerized).
 * On Linux the shell runs under `script` for a PTY and is resized out of band
 * (see `local-pty.ts`); the macOS dev fallback has no PTY and ignores resizes.
 */
function openHostShell(options: OpenShellOptions): ShellSession {
	const { cols, rows } = clampTerminalSize(options);
	const container = isInContainer();
	const pty = hasLocalPty();

	let proc: ChildProcessWithoutNullStreams;

	if (pty) {
		const shell = container ? "bash" : process.env.SHELL || "/bin/bash";
		const target = options.command ?? (container ? shell : `${shell} -i`);
		// `script` allocates the PTY inside the host namespaces when
		// containerized, so the size is applied from inside with stty.
		const argv = [
			...(container ? NSENTER_HOST : []),
			"script",
			"-qefc",
			ptyBootstrap(target, rows, cols),
			"/dev/null",
		];
		proc = spawn(argv[0], argv.slice(1), {
			stdio: ["pipe", "pipe", "pipe"],
			env: hostEnv({ TERM: "xterm-256color" }),
		});
	} else {
		const shell = process.env.SHELL || "/bin/zsh";
		const [command, args] = options.command
			? ["sh", ["-c", options.command]]
			: [shell, ["-i"]];
		proc = spawn(command, args, {
			env: hostEnv({
				TERM: "xterm-256color",
				COLUMNS: String(cols),
				LINES: String(rows),
			}),
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	let closed = false;
	const marker = new PtyMarkerReader();
	// One decoder per stream: a multi-byte character split across chunks is
	// held back until its remaining bytes arrive.
	const outDecoder = new StringDecoder("utf8");
	const errDecoder = new StringDecoder("utf8");
	const emit = (text: string) => {
		if (text) options.onData(text);
	};

	// With a PTY, stdout carries the merged terminal output; stderr only
	// sees errors from `script`/nsenter themselves.
	proc.stdout.on("data", (data: Buffer) =>
		emit(pty ? marker.push(outDecoder.write(data)) : outDecoder.write(data)),
	);
	proc.stderr.on("data", (data: Buffer) => emit(errDecoder.write(data)));
	proc.stdout.on("end", () => emit(outDecoder.end()));
	proc.stderr.on("end", () => emit(errDecoder.end()));
	// `closed` guarantees exactly one of onClose/onError is reported.
	proc.on("close", () => {
		if (!closed) {
			closed = true;
			options.onClose();
		}
	});
	proc.on("error", (err) => {
		if (!closed) {
			closed = true;
			options.onError(err);
		}
	});

	const resize = createResizer(async (nextRows, nextCols) => {
		if (closed || !marker.path) return;
		await execHost(resizeCommand(marker.path, nextRows, nextCols), {
			timeoutMs: getConfig().TERMINAL_RESIZE_TIMEOUT_MS,
		});
	});

	return {
		write: (data) => {
			if (!closed) proc.stdin.write(data);
		},
		resize: (nextRows, nextCols) => {
			if (!pty) return;
			const size = clampTerminalSize({ rows: nextRows, cols: nextCols });
			resize(size.rows, size.cols);
		},
		close: () => {
			if (closed) return;
			closed = true;
			try {
				proc.kill("SIGTERM");
			} catch {
				// ignore
			}
		},
	};
}

/**
 * Executor for the machine Nitrobase runs on. Inside a container it enters
 * the host namespaces (requires `privileged` + `pid: host`).
 */
export class LocalExecutor implements Executor {
	readonly kind = "local" as const;

	exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return execHost(command, options);
	}

	upload(
		content: string | Buffer,
		remotePath: string,
		mode?: string,
	): Promise<void> {
		return writeManagedFile(execHost, content, remotePath, mode);
	}

	readFile(remotePath: string): Promise<string> {
		return readManagedFile(execHost, remotePath);
	}

	async shell(options: OpenShellOptions): Promise<ShellSession> {
		return openHostShell(options);
	}

	close(): void {
		// Nothing to release; each command is its own process.
	}
}
