import { describe, expect, it } from "vitest";
import { logLevelPatterns } from "#/config/log-formats.ts";
import { detectLogLevel, detectLogLine, levelFromValue } from "./log-level";

describe("detectLogLevel", () => {
	it.each([
		// logfmt
		['time=2026-01-02T03:04:05Z level=warn msg="disk almost full"', "warning"],
		["ts=1 lvl=error msg=boom", "error"],
		// glog (kubernetes, some Go services)
		["E0102 03:04:05.678901       1 controller.go:42] sync failed", "error"],
		["I0102 03:04:05.678901       1 main.go:10] started", "info"],
		// nginx / kong
		["2026/01/02 03:04:05 [error] 1#0: *3 connect() failed", "error"],
		["2026/01/02 03:04:05 [warn] 1#0: using uninitialized variable", "warning"],
		["2026/01/02 03:04:05 [notice] 1#0: start worker processes", "info"],
		["2026/01/02 03:04:05 [crit] 1#0: SSL_do_handshake() failed", "error"],
		// elixir (realtime, analytics)
		["03:04:05.678 [error] GenServer terminating", "error"],
		["03:04:05.678 project=realtime external_id=x [info] Joined", "info"],
		["[ERROR] something broke", "error"],
		// Postgres
		[
			'2026-01-02 03:04:05.678 UTC [42] FATAL:  role "x" does not exist',
			"error",
		],
		[
			"2026-01-02 03:04:05.678 UTC [42] ERROR:  relation does not exist",
			"error",
		],
		["2026-01-02 03:04:05.678 UTC [42] WARNING:  no index", "warning"],
		["2026-01-02 03:04:05.678 UTC [1] LOG:  database system is ready", "info"],
		// leading words
		["WARN[0001] retrying connection", "warning"],
		["INFO   [2026-01-02T03:04:05Z] Starting server", "info"],
		["DEBUG cache miss", "info"],
		["FATAL could not bind", "error"],
		["SUCCESS: done", "success"],
		// after a time
		["2026-01-02 03:04:05,678 WARNING worker restarted", "warning"],
		["2026-01-02 03:04:05 ERROR boom", "error"],
		// colon prefixes and exceptions
		["panic: runtime error: index out of range", "error"],
		["error: could not connect", "error"],
		["Warning: deprecated option", "warning"],
		["TypeError: Cannot read properties of undefined", "error"],
		["Traceback (most recent call last):", "error"],
	])("%s → %s", (line, level) => {
		expect(detectLogLevel(line)).toBe(level);
	});

	it.each([
		"GET /health 200 1.2ms",
		"Listening on 0.0.0.0:3000",
		"the log in page was served",
		"01/Jan/2026:03:04:05 +0000: Starting PostgREST 12.0.0...",
		"",
	])("finds no level in %j", (line) => {
		expect(detectLogLevel(line)).toBeNull();
	});

	it("every pattern's example matches", () => {
		for (const pattern of logLevelPatterns) {
			expect(detectLogLevel(pattern.example), pattern.id).not.toBeNull();
		}
	});
});

describe("levelFromValue", () => {
	it("maps words and pino numbers", () => {
		expect(levelFromValue("WARNING")).toBe("warning");
		expect(levelFromValue("err")).toBe("error");
		expect(levelFromValue(30)).toBe("info");
		expect(levelFromValue(40)).toBe("warning");
		expect(levelFromValue(50)).toBe("error");
		expect(levelFromValue(60)).toBe("error");
		expect(levelFromValue("50")).toBe("error");
		expect(levelFromValue("verbose")).toBe("info");
		expect(levelFromValue("unknown")).toBeNull();
		expect(levelFromValue(undefined)).toBeNull();
	});
});

describe("detectLogLine", () => {
	it("reads JSON logs (gotrue)", () => {
		const line =
			'{"component":"api","level":"error","msg":"invalid token","time":"2026-01-02T03:04:05Z"}';
		expect(detectLogLine(line)).toEqual({
			raw: line,
			source: undefined,
			time: "03:04:05",
			timestamp: "2026-01-02T03:04:05Z",
			message: "invalid token",
			level: "error",
			json: true,
		});
	});

	it("reads pino numeric levels and epoch times (storage, meta)", () => {
		const parsed = detectLogLine(
			'{"level":40,"time":1767323045000,"msg":"slow query"}',
		);
		expect(parsed.level).toBe("warning");
		expect(parsed.message).toBe("slow query");
		expect(parsed.time).toBe("03:04:05");
	});

	it("keeps the whole JSON line when it has no message field", () => {
		const line = '{"severity":"INFO","event":"tick"}';
		const parsed = detectLogLine(line);
		expect(parsed.level).toBe("info");
		expect(parsed.message).toBe(line);
	});

	it("strips Docker timestamps and Compose prefixes", () => {
		const parsed = detectLogLine(
			"auth-1  | 2026-01-02T03:04:05.123456789Z level=warn msg=retry",
			{ composePrefix: true },
		);
		expect(parsed).toMatchObject({
			source: "auth-1",
			time: "03:04:05",
			timestamp: "2026-01-02T03:04:05.123456789Z",
			message: "level=warn msg=retry",
			level: "warning",
			json: false,
		});
	});

	it("leaves `|` alone without the Compose prefix option", () => {
		expect(detectLogLine("a | b").message).toBe("a | b");
	});

	it("returns no level for plain lines", () => {
		expect(detectLogLine("Listening on 0.0.0.0:3000")).toMatchObject({
			level: null,
			message: "Listening on 0.0.0.0:3000",
		});
	});

	it("does not treat broken JSON as JSON", () => {
		expect(detectLogLine('{"level":"error"').json).toBe(false);
	});
});
