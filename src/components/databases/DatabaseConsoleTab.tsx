import { useLingui } from "@lingui/react";
import {
	Alert,
	Badge,
	Button,
	Code,
	Group,
	ScrollArea,
	Stack,
	Switch,
	Table,
	Text,
	Textarea,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { Play } from "lucide-react";
import { useState } from "react";
import { useCan } from "#/components/teams/useCan";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { databaseConsoleKinds } from "#/config/database-engines.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import { runConsoleFn } from "#/features/databases/databases.functions.ts";
import type {
	ConsoleResult,
	DatabaseOverview,
} from "#/features/databases/schema.ts";
import { formatNumber } from "#/libs/intl.ts";

/**
 * Database console: SQL (Postgres, MySQL/MariaDB) with a result grid, or a
 * one-command runner (Valkey, MongoDB). Read-only by default; write mode
 * needs database.write and every statement is audited.
 */
export const DatabaseConsoleTab: React.FC<{
	overview: AppOverview;
	database: DatabaseOverview;
}> = ({ database }) => {
	const { i18n } = useLingui();
	const can = useCan();
	const kind = databaseConsoleKinds[database.consoleKind];
	const [input, setInput] = useState("");
	const [target, setTarget] = useState(database.database ?? "");
	const [write, setWrite] = useState(false);
	const [result, setResult] = useState<ConsoleResult | null>(null);
	const run = useAppMutation({
		mutationFn: async () =>
			await runConsoleFn({
				data: {
					databaseId: database.id,
					input,
					database: target.trim() || undefined,
					write,
				},
			}),
		field: "console",
		onSuccess: setResult,
		onMutate: () => setResult(null),
	});
	const running = database.status === "running";

	return (
		<Stack gap="md">
			<SectionCard
				title={i18n._(kind.title)}
				description={i18n._(kind.description)}
				actions={
					write ? (
						<Badge color="red" variant="filled">
							{i18n._("Write mode")}
						</Badge>
					) : (
						<Badge color="green" variant="light">
							{i18n._("Read-only")}
						</Badge>
					)
				}
			>
				<Stack gap="sm">
					{!running && (
						<Alert color="yellow">
							{i18n._(
								"The database is not running: start or redeploy it first.",
							)}
						</Alert>
					)}
					<Textarea
						aria-label={i18n._("Query")}
						placeholder={kind.example}
						value={input}
						onChange={(event) => setInput(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								(event.metaKey || event.ctrlKey) &&
								input.trim()
							) {
								event.preventDefault();
								run.mutate();
							}
						}}
						autosize
						minRows={kind.minRows}
						maxRows={20}
						styles={{
							input: { fontFamily: "var(--mantine-font-family-monospace)" },
						}}
					/>
					<Group justify="space-between" wrap="wrap">
						<Group gap="md" wrap="wrap">
							{kind.picksDatabase && (
								<TextInput
									size="xs"
									label={i18n._("Database")}
									value={target}
									onChange={(event) => setTarget(event.currentTarget.value)}
									w={180}
								/>
							)}
							<Tooltip
								label={i18n._(
									"Write mode needs the “Run writing statements…” database permission. Each statement is recorded in the audit log (string values hidden).",
								)}
								withArrow
								multiline
								w={280}
							>
								<Switch
									label={i18n._("Write mode")}
									color="red"
									checked={write}
									disabled={!can("database.write")}
									onChange={(event) => setWrite(event.currentTarget.checked)}
									mt={kind.picksDatabase ? 20 : 0}
								/>
							</Tooltip>
						</Group>
						<Button
							leftSection={<Play size={14} />}
							color={write ? "red" : undefined}
							disabled={!input.trim() || !running}
							loading={run.isPending}
							onClick={() => run.mutate()}
						>
							{write ? i18n._("Run (write)") : i18n._("Run")}
						</Button>
					</Group>
					{write && (
						<Alert color="red" variant="light">
							{i18n._(
								"Write mode runs as the database's superuser: changes are committed right away and can't be undone.",
							)}
						</Alert>
					)}
					{run.fieldError("console") && (
						<Alert color="red">{run.fieldError("console")}</Alert>
					)}
				</Stack>
			</SectionCard>
			{result && <ConsoleResultView result={result} />}
		</Stack>
	);
};

/** Positional ids for result cells (rows and columns have no identity). */
function keyed<T>(items: T[]): { id: string; value: T }[] {
	return items.map((value, position) => ({ id: `p${position}`, value }));
}

const ConsoleResultView: React.FC<{ result: ConsoleResult }> = ({ result }) => {
	const { i18n } = useLingui();
	const meta = (
		<Group gap="xs">
			{result.kind === "grid" && (
				<Text size="xs" c="dimmed">
					{i18n._("{count, plural, one {# row} other {# rows}}", {
						count: result.rows.length,
					})}
				</Text>
			)}
			<Text size="xs" c="dimmed">
				{formatNumber(i18n.locale, result.durationMs, {
					style: "unit",
					unit: "millisecond",
					unitDisplay: "short",
				})}
			</Text>
			{result.truncated && (
				<Badge size="xs" color="yellow" variant="light">
					{i18n._("Truncated")}
				</Badge>
			)}
		</Group>
	);
	if (result.error) {
		return (
			<Alert color="red" title={i18n._("The statement failed")}>
				<Code block style={{ whiteSpace: "pre-wrap" }}>
					{result.error}
				</Code>
			</Alert>
		);
	}
	if (result.kind === "grid") {
		return (
			<SectionCard title={i18n._("Result")} actions={meta} flush>
				{result.rows.length === 0 ? (
					<Text size="sm" c="dimmed" p="md">
						{i18n._("No rows.")}
					</Text>
				) : (
					<ScrollArea type="auto" mah={520}>
						<Table striped withColumnBorders stickyHeader fz="xs">
							<Table.Thead>
								<Table.Tr>
									{keyed(result.columns).map((column) => (
										<Table.Th key={column.id} ff="monospace">
											{column.value}
										</Table.Th>
									))}
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{keyed(result.rows).map((row) => (
									<Table.Tr key={row.id}>
										{keyed(row.value).map((cell) => (
											<Table.Td
												key={cell.id}
												ff="monospace"
												style={{ whiteSpace: "pre" }}
											>
												{cell.value === null ? (
													<Text span c="dimmed" size="xs">
														NULL
													</Text>
												) : (
													cell.value
												)}
											</Table.Td>
										))}
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					</ScrollArea>
				)}
				{result.truncated && (
					<Text size="xs" c="dimmed" p="sm">
						{i18n._(
							"Only the first {count} rows are shown: add a LIMIT to see others.",
							{ count: formatNumber(i18n.locale, result.rows.length) },
						)}
					</Text>
				)}
			</SectionCard>
		);
	}
	return (
		<SectionCard title={i18n._("Result")} actions={meta}>
			{result.text ? (
				<ScrollArea type="auto" mah={520}>
					<Code block style={{ whiteSpace: "pre-wrap" }}>
						{result.text}
					</Code>
				</ScrollArea>
			) : (
				<Text size="sm" c="dimmed">
					{i18n._("Done (no result set).")}
				</Text>
			)}
		</SectionCard>
	);
};
