import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { getConfig } from "#/config/server.ts";
import { AppError, internalError } from "#/utils/error.ts";
import {
	clampTerminalSize,
	commandTimeoutMs,
	type ExecOptions,
	type ExecResult,
	type Executor,
	killTaggedCommand,
	type OpenShellOptions,
	readManagedFile,
	type ShellSession,
	withRemoteTimeout,
	writeManagedFile,
} from "./executor";
import { fingerprintOf } from "./ssh-key-parse";

/**
 * Trust-on-first-use host key policy. `expected` is the stored SHA256
 * fingerprint; when absent, the first successful connection reports the
 * observed key through `onFirstSeen` (which should persist it).
 */
export interface HostKeyPolicy {
	expected?: string | null;
	onFirstSeen?: (fingerprint: string) => Promise<void> | void;
}

/**
 * Decrypted credentials for one SSH target. Exactly one auth method is
 * normally set: `privateKey` (+ optional `passphrase`) or `password`.
 * Never persist or log this object.
 */
export interface SSHConnection {
	host: string;
	port: number;
	username: string;
	privateKey?: string;
	password?: string;
	passphrase?: string;
	hostKey?: HostKeyPolicy;
}

export class HostKeyMismatchError extends AppError<"HOST_KEY_MISMATCH"> {
	constructor(
		readonly expected: string,
		readonly actual: string,
	) {
		super("HOST_KEY_MISMATCH", { expected, actual });
		this.name = "HostKeyMismatchError";
	}
}

/** A failed SSH connection (ssh2's own reason as detail). */
export class SshConnectionError extends AppError<"SSH_CONNECTION_FAILED"> {
	constructor(readonly reason: string) {
		super("SSH_CONNECTION_FAILED", { detail: reason });
		this.name = "SshConnectionError";
	}
}

function toConnectConfig(
	connection: SSHConnection,
	readyTimeout = getConfig().SSH_READY_TIMEOUT_MS,
): ConnectConfig {
	const config: ConnectConfig = {
		host: connection.host,
		port: connection.port,
		username: connection.username,
		readyTimeout,
		keepaliveInterval: getConfig().SSH_KEEPALIVE_MS,
	};
	if (connection.privateKey) {
		config.privateKey = connection.privateKey;
		if (connection.passphrase) {
			config.passphrase = connection.passphrase;
		}
	} else if (connection.password) {
		config.password = connection.password;
	}
	return config;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Connect and authenticate, enforcing the host key policy. Resolves once
 * the connection is ready (and a first-seen host key was persisted).
 */
function openClient(
	connection: SSHConnection,
	readyTimeout?: number,
): Promise<Client> {
	return new Promise<Client>((resolve, reject) => {
		const conn = new Client();
		let ready = false;
		let observed: string | null = null;
		let mismatch: HostKeyMismatchError | null = null;
		const expected = connection.hostKey?.expected ?? null;

		const config = toConnectConfig(connection, readyTimeout);
		config.hostVerifier = (key: Buffer) => {
			observed = fingerprintOf(key);
			if (expected && observed !== expected) {
				mismatch = new HostKeyMismatchError(expected, observed);
				return false;
			}
			return true;
		};

		conn
			.on("ready", () => {
				ready = true;
				const policy = connection.hostKey;
				if (!expected && observed && policy?.onFirstSeen) {
					const fingerprint = observed;
					Promise.resolve(policy.onFirstSeen(fingerprint))
						.then(() => {
							// Later connections in the same job must match it too.
							policy.expected = fingerprint;
							resolve(conn);
						})
						.catch((error) => {
							conn.end();
							reject(error);
						});
					return;
				}
				resolve(conn);
			})
			.on("error", (err) => {
				if (ready) return;
				reject(mismatch ?? new SshConnectionError(err.message));
			})
			.on("close", () => {
				if (!ready) reject(mismatch ?? new AppError("SSH_CONNECTION_CLOSED"));
			});
		try {
			// ssh2 throws synchronously for unparseable/encrypted keys.
			conn.connect(config);
		} catch (error) {
			reject(new SshConnectionError(errorMessage(error)));
		}
	});
}

/**
 * Test SSH connection without executing commands.
 */
export async function testConnection(connection: SSHConnection): Promise<{
	success: boolean;
	/** Why it failed (coded; ssh2's reason as detail). */
	error?: unknown;
	hostKeyMismatch?: { expected: string; actual: string };
}> {
	try {
		const conn = await openClient(connection, getConfig().SSH_TEST_TIMEOUT_MS);
		conn.end();
		return { success: true };
	} catch (error) {
		if (error instanceof HostKeyMismatchError) {
			return {
				success: false,
				error,
				hostKeyMismatch: { expected: error.expected, actual: error.actual },
			};
		}
		return { success: false, error };
	}
}

/**
 * Executor over a single lazily-opened SSH connection. Commands run as
 * separate channels on that connection; call `close()` when the job ends.
 */
export class SshExecutor implements Executor {
	readonly kind = "ssh" as const;
	private client: Promise<Client> | null = null;
	private closed = false;

	constructor(private readonly connection: SSHConnection) {}

	private connect(): Promise<Client> {
		if (this.closed) return Promise.reject(internalError("Executor is closed"));
		if (this.client) return this.client;

		const pending = openClient(this.connection).then((conn) => {
			conn.on("close", () => {
				// Next call reconnects instead of using a dead client.
				if (this.client === pending) {
					this.client = null;
				}
			});
			conn.on("error", () => {
				// Surfaced through the running command's close handling.
			});
			return conn;
		});
		this.client = pending;
		pending.catch(() => {
			if (this.client === pending) this.client = null;
		});
		return pending;
	}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const conn = await this.connect();
		const tag = randomUUID().replace(/-/g, "").slice(0, 16);
		// Signals over the channel don't work for root logins; kill the
		// tagged process tree from a second channel instead.
		const killRemote = (signal: "TERM" | "KILL") => {
			conn.exec(killTaggedCommand(tag, signal), (err, stream) => {
				if (!err) stream.resume();
			});
		};
		return new Promise((resolve, reject) => {
			let settled = false;
			let channel: ClientChannel | null = null;
			const timeoutMs = options?.timeoutMs ?? commandTimeoutMs();
			// Remote `timeout` fires first; this is the fallback if it's missing.
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				killRemote("KILL");
				channel?.close();
				reject(
					new AppError("COMMAND_TIMEOUT", { duration: { $ms: timeoutMs } }),
				);
			}, timeoutMs + getConfig().SSH_TIMEOUT_SLACK_MS);

			const onConnClose = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(new AppError("SSH_CONNECTION_LOST"));
			};
			conn.once("close", onConnClose);
			const onAbort = () => {
				// `timeout` forwards TERM to its process group. Resume a paused
				// channel (backpressure) so a blocked writer can see it end.
				killRemote("TERM");
				channel?.resume();
				setTimeout(() => {
					if (settled) return;
					killRemote("KILL");
					channel?.close();
				}, getConfig().PROCESS_KILL_GRACE_MS).unref();
			};
			if (options?.signal?.aborted) {
				settled = true;
				clearTimeout(timer);
				conn.off("close", onConnClose);
				resolve({ stdout: "", stderr: "", exitCode: 130 });
				return;
			}
			options?.signal?.addEventListener("abort", onAbort, { once: true });

			conn.exec(withRemoteTimeout(command, timeoutMs, tag), (err, stream) => {
				if (err) {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					conn.off("close", onConnClose);
					reject(err);
					return;
				}
				channel = stream;
				options?.onFlowControl?.({
					pause: () => stream.pause(),
					resume: () => stream.resume(),
				});
				const outDecoder = new StringDecoder("utf8");
				const errDecoder = new StringDecoder("utf8");
				let stdout = "";
				let stderr = "";

				stream
					.on("close", (code: number | null) => {
						conn.off("close", onConnClose);
						options?.signal?.removeEventListener("abort", onAbort);
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						stdout += outDecoder.end();
						stderr += errDecoder.end();
						resolve({
							stdout: stdout.trim(),
							stderr: stderr.trim(),
							exitCode: code ?? (options?.signal?.aborted ? 130 : 1),
						});
					})
					.on("data", (data: Buffer) => {
						options?.onStdoutData?.(data);
						if (options?.onStdoutData && options.discardOutput) return;
						const text = outDecoder.write(data);
						if (!options?.discardOutput) stdout += text;
						if (text) options?.onStdout?.(text);
					});
				stream.stderr.on("data", (data: Buffer) => {
					const text = errDecoder.write(data);
					if (!options?.discardOutput) stderr += text;
					if (text) options?.onStderr?.(text);
				});

				if (options?.input !== undefined) {
					stream.end(options.input);
				}
			});
		});
	}

	upload(
		content: string | Buffer,
		remotePath: string,
		mode?: string,
	): Promise<void> {
		return writeManagedFile(this.exec.bind(this), content, remotePath, mode);
	}

	readFile(remotePath: string): Promise<string> {
		return readManagedFile(this.exec.bind(this), remotePath);
	}

	async shell(options: OpenShellOptions): Promise<ShellSession> {
		const conn = await this.connect();
		const size = clampTerminalSize(options);
		return new Promise((resolve, reject) => {
			let closed = false;
			const pty = { term: "xterm-256color", cols: size.cols, rows: size.rows };
			const open = (
				callback: (err: Error | undefined, stream: ClientChannel) => void,
			) =>
				options.command
					? conn.exec(options.command, { pty }, callback)
					: conn.shell(pty, callback);
			open((err, stream) => {
				if (err) {
					reject(err);
					return;
				}
				const decoder = new StringDecoder("utf8");
				stream
					.on("data", (data: Buffer) => options.onData(decoder.write(data)))
					.on("close", () => {
						if (closed) return;
						closed = true;
						options.onClose();
					})
					.on("error", (streamErr: Error) => options.onError(streamErr));
				stream.stderr.on("data", (data: Buffer) =>
					options.onData(data.toString("utf8")),
				);

				resolve({
					write: (data) => {
						if (!closed) stream.write(data);
					},
					resize: (rows, cols) => {
						if (closed) return;
						const next = clampTerminalSize({ rows, cols });
						stream.setWindow(next.rows, next.cols, 0, 0);
					},
					close: () => {
						if (closed) return;
						closed = true;
						try {
							stream.end();
						} catch {
							// ignore
						}
					},
				});
			});
		});
	}

	close(): void {
		this.closed = true;
		const client = this.client;
		this.client = null;
		client?.then((conn) => conn.end()).catch(() => {});
	}
}
