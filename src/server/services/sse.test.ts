import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "#/config/server.ts";
import { SessionEndedError } from "./auth/live-connections";
import { createSseStream } from "./sse";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return text;
		text += decoder.decode(value);
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("createSseStream", () => {
	it("sends events, runs cleanups once and closes", async () => {
		const cleanup = vi.fn();
		const stream = createSseStream({
			signal: new AbortController().signal,
			start(channel) {
				channel.onClose(cleanup);
				channel.event("log", { line: "a" }, 1);
				channel.close();
				channel.close();
			},
		});
		expect(await readAll(stream)).toBe(
			'id: 1\nevent: log\ndata: {"line":"a"}\n\n',
		);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("sends heartbeats at SSE_HEARTBEAT_MS", async () => {
		vi.useFakeTimers();
		const abort = new AbortController();
		const stream = createSseStream({ signal: abort.signal, start() {} });
		const reading = readAll(stream);
		await vi.advanceTimersByTimeAsync(getConfig().SSE_HEARTBEAT_MS * 2);
		abort.abort();
		expect(await reading).toBe(": ping\n\n: ping\n\n");
	});

	it("tells the client when its session ended", async () => {
		const abort = new AbortController();
		const stream = createSseStream({ signal: abort.signal, start() {} });
		const reading = readAll(stream);
		abort.abort(new SessionEndedError("revoked"));
		expect(await reading).toContain('event: session_ended\ndata: {"message"');
	});

	it("runs cleanups when the client cancels", async () => {
		const cleanup = vi.fn();
		const stream = createSseStream({
			signal: new AbortController().signal,
			start(channel) {
				channel.onClose(cleanup);
			},
		});
		await stream.cancel();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});
});
