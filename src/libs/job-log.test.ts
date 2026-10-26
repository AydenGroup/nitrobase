import { describe, expect, it } from "vitest";
import {
	createLineDeduper,
	encodeSSE,
	formatLogLine,
	lastProgressFrame,
	logLinesFrom,
	MAX_LOG_LINE_LENGTH,
	parseLastEventId,
	parseLogLine,
	splitLogChunk,
} from "./job-log";

describe("formatLogLine", () => {
	it("prefixes a UTC HH:MM:SS timestamp", () => {
		expect(formatLogLine("hello", new Date("2026-01-02T03:04:05Z"))).toBe(
			"[03:04:05] hello",
		);
	});

	it("truncates very long lines", () => {
		const line = formatLogLine("x".repeat(MAX_LOG_LINE_LENGTH * 2));
		expect(line.length).toBe(MAX_LOG_LINE_LENGTH + 1);
		expect(line.endsWith("…")).toBe(true);
	});
});

describe("splitLogChunk", () => {
	it("returns complete lines and keeps the remainder", () => {
		expect(splitLogChunk("", "a\nb\r\nc")).toEqual({
			lines: ["a", "b"],
			rest: "c",
		});
		expect(splitLogChunk("c", "d\n\n")).toEqual({ lines: ["cd"], rest: "" });
	});
});

describe("encodeSSE", () => {
	it("encodes JSON data with optional id", () => {
		expect(encodeSSE("log", "a\nb", 3)).toBe(
			'id: 3\nevent: log\ndata: "a\\nb"\n\n',
		);
		expect(encodeSSE("complete", { status: "success" })).toBe(
			'event: complete\ndata: {"status":"success"}\n\n',
		);
	});

	it("never emits raw newlines inside data", () => {
		const frame = encodeSSE("log", "line1\nline2\r\nline3");
		expect(frame.split("\n").filter((l) => l.startsWith("data:"))).toHaveLength(
			1,
		);
	});
});

describe("parseLastEventId", () => {
	it("parses non-negative integers and defaults to 0", () => {
		expect(parseLastEventId("42")).toBe(42);
		expect(parseLastEventId(null)).toBe(0);
		expect(parseLastEventId("abc")).toBe(0);
		expect(parseLastEventId("-5")).toBe(0);
	});
});

describe("parseLogLine", () => {
	it("marks warnings", () => {
		expect(parseLogLine("[10:00:00] warning: volume x skipped").level).toBe(
			"warning",
		);
	});

	it("extracts time and level", () => {
		expect(parseLogLine("[10:00:00] ERROR: boom")).toEqual({
			time: "10:00:00",
			message: "ERROR: boom",
			level: "error",
		});
		expect(parseLogLine("SUCCESS: done").level).toBe("success");
		expect(parseLogLine("[10:00:00] working").level).toBe("info");
	});
});

describe("progress output", () => {
	it("keeps the last CR frame and strips ANSI", () => {
		expect(
			logLinesFrom("Pulling 10%\rPulling 50%\rPulling 100%\nDone\r\n"),
		).toEqual(["Pulling 100%", "Done"]);
		expect(logLinesFrom("\u001b[32mgreen\u001b[0m text")).toEqual([
			"green text",
		]);
		expect(lastProgressFrame("a\r\r")).toBe("a");
	});

	it("drops consecutive duplicate lines (compose prints to both streams)", () => {
		const keep = createLineDeduper();
		const lines = [
			"Container x Creating",
			"Container x Creating",
			"Container x Created",
			"Container x Creating",
		];
		expect(lines.filter(keep)).toEqual([
			"Container x Creating",
			"Container x Created",
			"Container x Creating",
		]);
	});

	it("handles CR progress in streamed chunks", () => {
		expect(splitLogChunk("", "a 1%\ra 99%\nb")).toEqual({
			lines: ["a 99%"],
			rest: "b",
		});
	});
});
