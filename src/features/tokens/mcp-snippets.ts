import { APP_ID } from "#/config/shared.ts";

/**
 * Client setup snippets for the MCP server (Settings → API tokens →
 * Connect an AI agent). Pure: the panel shows them with a placeholder, the
 * one-time reveal of a new token with the token itself.
 */

/** Where the MCP server answers (#/routes/api/mcp.ts). */
export const MCP_PATH = "/api/mcp";

/** Stands for the token in snippets shown without one. */
export const TOKEN_PLACEHOLDER = "<TOKEN>";

/** `https://panel.example.com/` → `https://panel.example.com/api/mcp`. */
export function mcpEndpoint(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${MCP_PATH}`;
}

/** POSIX shell word: bare when safe, else single-quoted. */
export function shellQuote(value: string): string {
	if (/^[\w@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

const authorization = (token: string) => `Bearer ${token}`;

/** `claude mcp add` for Claude Code. */
export function claudeCodeCommand(url: string, token: string): string {
	return [
		"claude mcp add --transport http",
		shellQuote(APP_ID),
		shellQuote(url),
		"--header",
		shellQuote(`Authorization: ${authorization(token)}`),
	].join(" ");
}

/**
 * `mcpServers` JSON of a remote (Streamable HTTP) server, as Cursor's
 * mcp.json and Claude Code's .mcp.json read it.
 */
export function mcpJsonConfig(url: string, token: string): string {
	return JSON.stringify(
		{
			mcpServers: {
				[APP_ID]: {
					type: "http",
					url,
					headers: { Authorization: authorization(token) },
				},
			},
		},
		null,
		2,
	);
}
