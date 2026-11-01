import { describe, expect, it } from "vitest";
import { APP_ID } from "#/config/shared.ts";
import {
	claudeCodeCommand,
	mcpEndpoint,
	mcpJsonConfig,
	publicBaseUrl,
	shellQuote,
	TOKEN_PLACEHOLDER,
} from "./mcp-snippets";

const ENDPOINT = "https://panel.example.com/api/mcp";

describe("MCP client snippets", () => {
	it("appends the MCP path to the base URL", () => {
		expect(mcpEndpoint("https://panel.example.com")).toBe(ENDPOINT);
		expect(mcpEndpoint("https://panel.example.com//")).toBe(ENDPOINT);
		expect(mcpEndpoint("http://10.0.0.5:3000")).toBe(
			"http://10.0.0.5:3000/api/mcp",
		);
	});

	it("shows the base URL without credentials, query or fragment", () => {
		expect(publicBaseUrl("https://user:pass@panel.example.com/")).toBe(
			"https://panel.example.com",
		);
		expect(publicBaseUrl("https://admin@panel.example.com/sub/?a=1#x")).toBe(
			"https://panel.example.com/sub",
		);
		expect(publicBaseUrl("http://10.0.0.5:3000")).toBe("http://10.0.0.5:3000");
		expect(publicBaseUrl(null)).toBeNull();
		expect(publicBaseUrl("not a url")).toBeNull();
	});

	it("quotes shell words only when needed, single quotes escaped", () => {
		expect(shellQuote(ENDPOINT)).toBe(ENDPOINT);
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("<TOKEN>")).toBe("'<TOKEN>'");
		expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
		expect(shellQuote("")).toBe("''");
	});

	it("builds the Claude Code command", () => {
		expect(claudeCodeCommand(ENDPOINT, "nbk_abc123")).toBe(
			`claude mcp add --transport http ${APP_ID} ${ENDPOINT} --header 'Authorization: Bearer nbk_abc123'`,
		);
		expect(claudeCodeCommand(`${ENDPOINT}?a=1&b=2`, TOKEN_PLACEHOLDER)).toBe(
			`claude mcp add --transport http ${APP_ID} '${ENDPOINT}?a=1&b=2' --header 'Authorization: Bearer <TOKEN>'`,
		);
	});

	it("builds the mcpServers JSON", () => {
		expect(JSON.parse(mcpJsonConfig(ENDPOINT, "nbk_abc123"))).toEqual({
			mcpServers: {
				[APP_ID]: {
					type: "http",
					url: ENDPOINT,
					headers: { Authorization: "Bearer nbk_abc123" },
				},
			},
		});
		// Escaped as JSON, not interpolated.
		expect(
			JSON.parse(mcpJsonConfig(ENDPOINT, 'a"b')).mcpServers[APP_ID],
		).toEqual(
			expect.objectContaining({ headers: { Authorization: 'Bearer a"b' } }),
		);
	});
});
