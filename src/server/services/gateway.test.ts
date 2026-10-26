import { describe, expect, it } from "vitest";
import {
	curlConfig,
	curlConfigString,
	gatewayCommand,
	gatewayUrl,
	parseGatewayResponse,
	WRITE_OUT_MARKER,
} from "./gateway";

const base = {
	network: "nitrobase-network",
	image: "curlimages/curl:8.16.0",
	container: "supabase-0123abcd-kong",
	port: 8000,
	path: "/functions/v1/hello",
	method: "POST" as const,
	headers: { apikey: "k", Authorization: "Bearer k" },
	body: '{"a":"b\\"c"}\n',
	timeoutMs: 30_000,
	maxResponseBytes: 1024,
};

describe("gateway request", () => {
	it("builds the URL only from validated parts", () => {
		expect(gatewayUrl(base)).toBe(
			"http://supabase-0123abcd-kong:8000/functions/v1/hello",
		);
		for (const path of [
			"functions",
			"/a/../../x",
			"/a?b=1",
			"/a#x",
			"/@evil",
		]) {
			expect(() => gatewayUrl({ ...base, path })).toThrow();
		}
		expect(() => gatewayUrl({ ...base, container: "evil.com:80/x" })).toThrow();
	});

	it("puts keys and body in the stdin config, escaped", () => {
		expect(curlConfigString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
		expect(curlConfig(base)).toBe(
			[
				'url = "http://supabase-0123abcd-kong:8000/functions/v1/hello"',
				'request = "POST"',
				'header = "apikey: k"',
				'header = "Authorization: Bearer k"',
				'data-binary = "{\\"a\\":\\"b\\\\\\"c\\"}\\n"',
				"",
			].join("\n"),
		);
		expect(() =>
			curlConfig({ ...base, headers: { "X-A": "x\r\nInjected: 1" } }),
		).toThrow();
		expect(curlConfig({ ...base, method: "GET" })).not.toContain("data-binary");
	});

	it("runs a throwaway curl on the proxy network without secrets in argv", () => {
		const command = gatewayCommand(base);
		expect(command).toBe(
			`docker run --rm -i --network 'nitrobase-network' 'curlimages/curl:8.16.0' -s -S -i --no-progress-meter --max-time 30 -w '%{stderr}${WRITE_OUT_MARKER}%{http_code} %{time_total}\\n' -K - | head -c 1025`,
		);
		expect(command).not.toContain("Bearer");
	});
});

describe("parseGatewayResponse", () => {
	it("parses status, headers, body and timing (skipping 100 Continue)", () => {
		const stdout =
			'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Type: application/json\r\nX-A: 1\r\n\r\n{"ok":true}';
		expect(
			parseGatewayResponse(stdout, `${WRITE_OUT_MARKER}201 0.042\n`, 1024),
		).toEqual({
			status: 201,
			headers: [
				["Content-Type", "application/json"],
				["X-A", "1"],
			],
			body: '{"ok":true}',
			timeSeconds: 0.042,
			truncated: false,
		});
	});

	it("flags truncation and handles no response", () => {
		const big = `HTTP/1.1 200 OK\r\n\r\n${"x".repeat(100)}`;
		expect(parseGatewayResponse(big, "", 50).truncated).toBe(true);
		expect(
			parseGatewayResponse("", "curl: (7) Failed to connect\n", 50).status,
		).toBeNull();
	});
});
