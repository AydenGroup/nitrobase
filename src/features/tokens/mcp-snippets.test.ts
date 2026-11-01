import { describe, expect, it } from "vitest";
import { APP_ID } from "#/config/shared.ts";
import {
	claudeCodeCommand,
	mcpEndpoint,
	mcpJsonConfig,
	shellQuote,
	TOKEN_PLACEHOLDER,
} from "./mcp-snippets";

const URL = "https://panel.example.com/api/mcp";

describe("MCP client snippets", () => {
	it("appends the MCP path to the base URL", () => {
		expect(mcpEndpoint("https://panel.example.com")).toBe(URL);
		expect(mcpEndpoint("https://panel.example.com//")).toBe(URL);
		expect(mcpEndpoint("http://10.0.0.5:3000")).toBe(
			"http://10.0.0.5:3000/api/mcp",
		);
	});

	it("quotes shell words only when needed, single quotes escaped", () => {
		expect(shellQuote(URL)).toBe(URL);
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("<TOKEN>")).toBe("'<TOKEN>'");
		expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
		expect(shellQuote("")).toBe("''");
	});

	it("builds the Claude Code command", () => {
		expect(claudeCodeCommand(URL, "nbk_abc123")).toBe(
			`claude mcp add --transport http ${APP_ID} ${URL} --header 'Authorization: Bearer nbk_abc123'`,
		);
		expect(claudeCodeCommand(`${URL}?a=1&b=2`, TOKEN_PLACEHOLDER)).toBe(
			`claude mcp add --transport http ${APP_ID} '${URL}?a=1&b=2' --header 'Authorization: Bearer <TOKEN>'`,
		);
	});

	it("builds the mcpServers JSON", () => {
		expect(JSON.parse(mcpJsonConfig(URL, "nbk_abc123"))).toEqual({
			mcpServers: {
				[APP_ID]: {
					type: "http",
					url: URL,
					headers: { Authorization: "Bearer nbk_abc123" },
				},
			},
		});
		// Escaped as JSON, not interpolated.
		expect(JSON.parse(mcpJsonConfig(URL, 'a"b')).mcpServers[APP_ID]).toEqual(
			expect.objectContaining({ headers: { Authorization: 'Bearer a"b' } }),
		);
	});
});
