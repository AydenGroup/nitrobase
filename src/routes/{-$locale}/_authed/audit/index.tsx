import { useLingui } from "@lingui/react";
import {
	Badge,
	Button,
	Group,
	SegmentedControl,
	Select,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Download, ScrollText, Search } from "lucide-react";
import { useState } from "react";
import { useCan } from "#/components/teams/useCan";
import { DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import {
	type AuditCategory,
	auditActions,
	auditCategories,
	isAuditAction,
} from "#/config/audit-actions.ts";
import { auditTargetTypes, isAuditTargetType } from "#/config/audit-targets.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { auditQueryOptions } from "#/features/audit/audit.query.ts";
import { clip } from "#/libs/format.ts";
import { formatDate } from "#/libs/intl.ts";

export const Route = createFileRoute("/{-$locale}/_authed/audit/")({
	loader: ({ context }) => ({ crumb: context.i18n._("Audit log") }),
	component: Page,
});

function Page() {
	const { i18n } = useLingui();
	const can = useCan();
	// Team activity needs audit.view; everyone sees their own account events.
	const [scope, setScope] = useState<"team" | "account">(
		can("audit.view") ? "team" : "account",
	);
	const [category, setCategory] = useState<string | null>(null);
	const [action, setAction] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [q] = useDebouncedValue(search.trim(), 300);
	const filters = {
		scope,
		category: category ?? undefined,
		action: action ?? undefined,
		q: q || undefined,
	};
	const query = useInfiniteQuery(auditQueryOptions(filters));
	const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
	const exportParams = new URLSearchParams(
		Object.entries(filters).filter(([, value]) => value) as [string, string][],
	);
	const label = (id: string) =>
		isAuditAction(id) ? i18n._(auditActions[id].label) : id;

	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Audit log")}
				description={i18n._(
					"Sign-ins, secret reveals, deploys and other sensitive actions. Secrets are never recorded.",
				)}
				actions={
					<Button
						variant="default"
						component="a"
						href={`/api/audit/export?${exportParams.toString()}`}
						leftSection={<Download size={16} />}
					>
						{i18n._("Export CSV")}
					</Button>
				}
			/>
			<SegmentedControl
				value={scope}
				onChange={(value) => setScope(value as "team" | "account")}
				data={[
					{
						value: "team",
						label: i18n._("Team activity"),
						disabled: !can("audit.view"),
					},
					{ value: "account", label: i18n._("My account") },
				]}
				w="fit-content"
			/>
			<Group align="flex-end">
				<Select
					label={i18n._("Category")}
					placeholder={i18n._("All")}
					data={Object.entries(auditCategories).map(([value, text]) => ({
						value,
						label: i18n._(text),
					}))}
					value={category}
					onChange={(value) => {
						setCategory(value);
						setAction(null);
					}}
					clearable
					w={200}
				/>
				<Select
					label={i18n._("Action")}
					placeholder={i18n._("All")}
					data={Object.entries(auditActions)
						.filter(
							([, meta]) =>
								!category || meta.category === (category as AuditCategory),
						)
						.map(([value, meta]) => ({ value, label: i18n._(meta.label) }))}
					value={action}
					onChange={setAction}
					clearable
					searchable
					w={260}
				/>
				<TextInput
					label={i18n._("Search")}
					placeholder={i18n._("Target, IP or details")}
					leftSection={<Search size={14} />}
					value={search}
					onChange={(event) => setSearch(event.currentTarget.value)}
					w={260}
				/>
			</Group>
			<SectionCard flush>
				<DataTable
					rows={rows}
					loading={query.isLoading}
					getRowKey={(row) => String(row.id)}
					empty={
						<EmptyState
							compact
							icon={ScrollText}
							title={i18n._("No matching events")}
							description={i18n._("Try other filters.")}
						/>
					}
					columns={[
						{
							key: "at",
							header: i18n._("Time"),
							render: (row) =>
								formatDate(i18n.locale, row.at, {
									dateStyle: "short",
									timeStyle: "medium",
								}),
						},
						{
							key: "action",
							header: i18n._("Action"),
							render: (row) => (
								<Stack gap={0}>
									<Text size="sm">{label(row.action)}</Text>
									<Text size="xs" c="dimmed" ff="monospace">
										{row.action}
									</Text>
								</Stack>
							),
						},
						{
							key: "target",
							header: i18n._("Target"),
							render: (row) =>
								row.targetType ? (
									<Group gap={4} wrap="nowrap">
										<Badge size="xs" variant="outline">
											{isAuditTargetType(row.targetType)
												? i18n._(auditTargetTypes[row.targetType])
												: row.targetType}
										</Badge>
										<Tooltip
											label={row.targetId ?? ""}
											disabled={!row.targetId || !row.targetName}
										>
											<Text
												size="xs"
												ff={row.targetName ? undefined : "monospace"}
												truncate
												maw={160}
											>
												{row.targetName ?? row.targetId}
											</Text>
										</Tooltip>
									</Group>
								) : (
									"—"
								),
						},
						{
							key: "who",
							header: i18n._("By"),
							hideOnMobile: true,
							render: (row) => (
								<Tooltip label={row.userAgent ?? ""} disabled={!row.userAgent}>
									<Stack gap={0}>
										<Text size="sm">{row.userEmail ?? "—"}</Text>
										<Text size="xs" c="dimmed">
											{row.ip ?? i18n._("system")}
										</Text>
									</Stack>
								</Tooltip>
							),
						},
						{
							key: "meta",
							header: i18n._("Details"),
							hideOnMobile: true,
							render: (row) => <MetaChips meta={row.meta} />,
						},
					]}
				/>
			</SectionCard>
			{query.hasNextPage && (
				<Group justify="center">
					<Button
						variant="default"
						loading={query.isFetchingNextPage}
						onClick={() => query.fetchNextPage()}
					>
						{i18n._("Load more")}
					</Button>
				</Group>
			)}
		</Stack>
	);
}

/** Audit metadata as `key: value` chips (nested values as compact JSON). */
function MetaChips({ meta }: { meta: string | null }) {
	if (!meta) return "—";
	let entries: [string, unknown][];
	try {
		const parsed = JSON.parse(meta) as unknown;
		entries =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? Object.entries(parsed as Record<string, unknown>)
				: [["", parsed]];
	} catch {
		entries = [["", meta]];
	}
	const text = (value: unknown) => {
		const raw = typeof value === "string" ? value : JSON.stringify(value);
		return raw.length > TEXT_LIMITS.auditCell
			? `${clip(raw, TEXT_LIMITS.auditCell)}…`
			: raw;
	};
	return (
		<Group gap={4}>
			{entries.slice(0, 12).map(([key, value]) => (
				<Badge
					key={key}
					size="sm"
					variant="light"
					color="gray"
					tt="none"
					style={{ maxWidth: 320 }}
				>
					{key ? `${key}: ${text(value)}` : text(value)}
				</Badge>
			))}
		</Group>
	);
}
