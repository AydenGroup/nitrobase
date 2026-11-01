import { useLingui } from "@lingui/react";
import { Anchor, Button, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { CopyField } from "#/components/ui/CopyField";
import { SectionCard } from "#/components/ui/SectionCard";
import { DOCS_LINKS } from "#/config/docs-links.ts";
import { APP_NAME } from "#/config/shared.ts";
import {
	mcpClientSnippets,
	mcpEndpoint,
	TOKEN_PLACEHOLDER,
} from "#/features/tokens/mcp-snippets.ts";
import { apiBaseUrlQueryOptions } from "#/features/tokens/tokens.query.ts";

/**
 * Base of the API and MCP URLs: the configured APP_URL, else the browser
 * origin (set after hydration, empty on the server render).
 */
export function useApiBaseUrl(): string {
	const { data: configured } = useQuery(apiBaseUrlQueryOptions);
	const [origin, setOrigin] = useState("");
	useEffect(() => setOrigin(window.location.origin), []);
	return configured ?? origin;
}

/** One copyable snippet per MCP client, for `token`. */
export const McpClientSnippets: React.FC<{ url: string; token: string }> = ({
	url,
	token,
}) => {
	const { i18n } = useLingui();
	return (
		<Stack gap="xs">
			{mcpClientSnippets.map((snippet) => (
				<Stack key={snippet.id} gap={4}>
					<Text size="xs" fw={500}>
						{i18n._(snippet.label)}
					</Text>
					<CopyField value={snippet.build(url, token)} block />
				</Stack>
			))}
		</Stack>
	);
};

/** Settings → API tokens: how to point an MCP client at this panel. */
export const ConnectAgentCard: React.FC<{ onCreateToken: () => void }> = ({
	onCreateToken,
}) => {
	const { i18n } = useLingui();
	const base = useApiBaseUrl();
	const url = base ? mcpEndpoint(base) : "";
	return (
		<SectionCard
			title={i18n._("Connect an AI agent")}
			description={i18n._(
				"Agents such as Claude Code or Cursor can drive {appName} through its MCP server, with an API token.",
				{ appName: APP_NAME },
			)}
			actions={
				<Button
					variant="default"
					leftSection={<Bot size={16} />}
					onClick={onCreateToken}
				>
					{i18n._("Create an agent token")}
				</Button>
			}
		>
			<Stack gap="sm">
				<Stack gap={4}>
					<Text size="xs" fw={500}>
						{i18n._("MCP endpoint")}
					</Text>
					<CopyField value={url} />
				</Stack>
				<McpClientSnippets url={url} token={TOKEN_PLACEHOLDER} />
				<Text size="xs" c="dimmed">
					{i18n._(
						"Replace {placeholder} with a token: a new token's own commands are shown when it is created. Tools follow the token's permissions, and most clients ask before running a destructive one.",
						{ placeholder: TOKEN_PLACEHOLDER },
					)}{" "}
					<Anchor
						href={DOCS_LINKS.mcpServer}
						target="_blank"
						rel="noreferrer"
						size="xs"
					>
						{i18n._("MCP server guide")}
					</Anchor>
				</Text>
			</Stack>
		</SectionCard>
	);
};
