import { getConfig } from "#/config/server.ts";
import { encodeSSE } from "#/libs/job-log.ts";
import { sessionEndedPayload } from "#/server/services/auth/live-connections.ts";

/** Response headers of every event stream (no proxy buffering). */
const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache, no-transform",
	"X-Accel-Buffering": "no",
} as const;

export interface SseChannel {
	/** Send one named event (JSON data; `id` for Last-Event-ID resume). */
	event(name: string, data: unknown, id?: number): void;
	/** End the stream (idempotent; tells the client when its session ended). */
	close(): void;
	/** Run `fn` when the stream ends, however it ends. */
	onClose(fn: () => void): void;
	readonly closed: boolean;
}

/**
 * An event stream with the parts every stream shares: a heartbeat comment
 * every SSE_HEARTBEAT_MS (proxies drop idle streams), `session_ended` when
 * `signal` aborted because the session ended, close on abort or when the
 * client goes away, and cleanup callbacks run exactly once.
 */
export function createSseStream(options: {
	/** Aborts when the client disconnects or the session is revoked. */
	signal: AbortSignal;
	start(channel: SseChannel): void | Promise<void>;
}): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const cleanups: (() => void)[] = [];
	let closed = false;
	const finish = () => {
		if (closed) return false;
		closed = true;
		options.signal.removeEventListener("abort", onAbort);
		for (const fn of cleanups.splice(0)) {
			try {
				fn();
			} catch {
				// a cleanup failing must not keep the others from running
			}
		}
		return true;
	};
	let onAbort = () => {};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (frame: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(frame));
				} catch {
					channel.close();
				}
			};
			const channel: SseChannel = {
				event: (name, data, id) => send(encodeSSE(name, data, id)),
				close: () => {
					if (closed) return;
					const ended = sessionEndedPayload(options.signal);
					if (ended) send(encodeSSE("session_ended", ended));
					if (!finish()) return;
					try {
						controller.close();
					} catch {
						// already closed
					}
				},
				onClose: (fn) => {
					if (closed) fn();
					else cleanups.push(fn);
				},
				get closed() {
					return closed;
				},
			};
			const heartbeat = setInterval(
				() => send(": ping\n\n"),
				getConfig().SSE_HEARTBEAT_MS,
			);
			cleanups.push(() => clearInterval(heartbeat));
			onAbort = () => channel.close();
			if (options.signal.aborted) {
				channel.close();
				return;
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
			// A failing start must still run cleanup (heartbeat, listeners).
			return Promise.resolve()
				.then(() => options.start(channel))
				.catch(() => channel.close());
		},
		cancel() {
			finish();
		},
	});
}

/** An event stream as an HTTP response. */
export function sseResponse(stream: ReadableStream<Uint8Array>): Response {
	return new Response(stream, { headers: SSE_HEADERS });
}
