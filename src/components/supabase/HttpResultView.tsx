import { useLingui } from "@lingui/react";
import {
	Alert,
	Badge,
	Code,
	Group,
	ScrollArea,
	Spoiler,
	Stack,
	Table,
	Text,
} from "@mantine/core";
import type { HttpResult } from "#/features/supabase/schema.ts";
import { formatDuration } from "#/libs/intl.ts";

function prettyBody(body: string): string {
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}

const statusColor = (status: number | null) =>
	status === null
		? "gray"
		: status < 300
			? "green"
			: status < 400
				? "blue"
				: status < 500
					? "yellow"
					: "red";

/** Status, timing, headers and body of a server-side HTTP call. */
export const HttpResultView: React.FC<{ result: HttpResult }> = ({
	result,
}) => {
	const { i18n } = useLingui();
	return (
		<Stack gap="xs">
			<Group gap="xs">
				<Badge color={statusColor(result.status)} variant="light">
					{result.status ?? i18n._("No response")}
				</Badge>
				{result.timeMs !== null && (
					<Text size="sm" c="dimmed">
						{formatDuration(i18n.locale, result.timeMs)}
					</Text>
				)}
				{result.truncated && (
					<Badge color="yellow" variant="outline">
						{i18n._("Truncated")}
					</Badge>
				)}
			</Group>
			{result.error && <Alert color="red">{result.error}</Alert>}
			{result.headers.length > 0 && (
				<Spoiler
					maxHeight={0}
					showLabel={i18n._("Show headers ({count})", {
						count: result.headers.length,
					})}
					hideLabel={i18n._("Hide headers")}
				>
					<Table fz="xs" withRowBorders={false}>
						<Table.Tbody>
							{result.headers.map(([name, value], index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: static list; header names repeat (set-cookie)
								<Table.Tr key={`${name}-${index}`}>
									<Table.Td c="dimmed" style={{ whiteSpace: "nowrap" }}>
										{name}
									</Table.Td>
									<Table.Td style={{ wordBreak: "break-all" }}>
										{value}
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Spoiler>
			)}
			<ScrollArea.Autosize mah={360}>
				<Code block>{prettyBody(result.body) || " "}</Code>
			</ScrollArea.Autosize>
		</Stack>
	);
};
