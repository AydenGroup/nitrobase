import { RELEASE_REPO_DEFAULT } from "./shared.ts";

/** External documentation the UI links to (client-safe, one place to update). */
export const DOCS_LINKS = {
	/** README → MCP server (connecting AI agents). */
	mcpServer: `https://github.com/${RELEASE_REPO_DEFAULT}#mcp-server`,
	/** Creating a remotely managed Cloudflare Tunnel and its hostnames. */
	cloudflareTunnel:
		"https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/",
} as const;
