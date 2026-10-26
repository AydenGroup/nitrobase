import { useLingui } from "@lingui/react";
import { Alert, Badge, Button, Group, Stack, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppJobDrawer } from "#/components/apps/AppJobDrawer";
import { useAppJob } from "#/components/apps/useAppJob";
import { DeploymentStatusBadge } from "#/components/dashboard/StatusBadge";
import { useCan } from "#/components/teams/useCan";
import { CodedList } from "#/components/ui/CodedList";
import { KeyValueList } from "#/components/ui/KeyValueList";
import { SectionCard } from "#/components/ui/SectionCard";
import {
	type CloudSyncProvider,
	getCloudSyncProvider,
	partsFor,
	providersForTemplate,
	syncDirectionLabels,
	syncPartLabel,
} from "#/config/cloud-sync.ts";
import { lookup } from "#/config/labels.ts";
import { pollWhile } from "#/config/polling.ts";
import { appSyncsQueryOptions } from "#/features/cloud-sync/cloud-sync.query.ts";
import type { CloudSyncDTO } from "#/features/cloud-sync/schema.ts";
import type { DeploymentStatus } from "#/features/servers/schema.ts";
import {
	EMPTY_VALUE,
	formatDate,
	formatList,
	formatNumber,
} from "#/libs/intl.ts";
import type { PluginTabProps } from "#/plugins/types.ts";
import { CloudExportModal } from "./CloudExportModal";

const STATUSES = new Set<string>(["pending", "running", "success", "failed"]);

/** Where the app was imported from, exports, and every sync since. */
export default function CloudSyncTab({ overview }: PluginTabProps) {
	const { i18n } = useLingui();
	const { app } = overview;
	const jobs = useAppJob(app.id);
	const canSync = useCan()("app.sync");
	const exporters = providersForTemplate(app.templateId).filter(
		(provider) => partsFor(provider, "export").length > 0,
	);
	const [exporting, setExporting] = useState<CloudSyncProvider | null>(null);
	const { data: syncs = [], error } = useQuery({
		...appSyncsQueryOptions(app.id),
		refetchInterval: (query) =>
			pollWhile(!!query.state.data?.some((sync) => sync.status === "running")),
	});
	if (error) return <Alert color="red">{error.message}</Alert>;
	const origin = [...syncs]
		.reverse()
		.find((sync) => sync.direction === "import");
	const when = (date: Date | string | null) =>
		date
			? formatDate(i18n.locale, date, {
					dateStyle: "medium",
					timeStyle: "short",
				})
			: EMPTY_VALUE;
	const parts = (sync: CloudSyncDTO) =>
		formatList(
			i18n.locale,
			sync.parts.map((part) => {
				const label = syncPartLabel(getCloudSyncProvider(sync.provider), part);
				return label ? i18n._(label) : part;
			}),
		);
	const providerLabel = (sync: CloudSyncDTO) => {
		const provider = getCloudSyncProvider(sync.provider);
		return provider ? i18n._(provider.label) : sync.provider;
	};
	const latest = syncs[0];

	const jobTitle = (sync: CloudSyncDTO) =>
		sync.direction === "export"
			? i18n._("Export to {provider}", { provider: providerLabel(sync) })
			: i18n._("Import from {provider}", { provider: providerLabel(sync) });

	return (
		<Stack gap="md">
			{canSync && exporters.length > 0 && (
				<SectionCard title={i18n._("Export to the cloud")}>
					<Stack gap="sm">
						<Text size="sm" c="dimmed">
							{i18n._(
								"Copy this app into a new, empty cloud project. The app keeps running here.",
							)}
						</Text>
						<Group>
							{exporters.map((provider) => (
								<Button
									key={provider.id}
									variant="light"
									onClick={() => setExporting(provider)}
								>
									{i18n._(provider.exportLabel)}
								</Button>
							))}
						</Group>
					</Stack>
				</SectionCard>
			)}
			<SectionCard title={i18n._("Import origin")}>
				{origin ? (
					<KeyValueList
						items={[
							{ label: i18n._("Provider"), value: providerLabel(origin) },
							{
								label: i18n._("Project"),
								value: (
									<Text size="sm" ff="monospace">
										{origin.project}
									</Text>
								),
							},
							{
								label: i18n._("Connection"),
								value: origin.connectionId ? (
									origin.connectionName
								) : (
									<Text size="sm" c="dimmed">
										{i18n._("{name} (deleted)", {
											name: origin.connectionName,
										})}
									</Text>
								),
							},
							{ label: i18n._("Imported"), value: when(origin.createdAt) },
							{ label: i18n._("Parts"), value: parts(origin) },
						]}
					/>
				) : (
					<Text size="sm" c="dimmed">
						{i18n._("This app was not imported from a cloud project.")}
					</Text>
				)}
			</SectionCard>

			{latest?.summary && <SyncSummary sync={latest} />}

			<SectionCard flush title={i18n._("Sync history")}>
				{syncs.length === 0 ? (
					<Text size="sm" c="dimmed" p="md">
						{i18n._("No syncs yet.")}
					</Text>
				) : (
					<Table highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{i18n._("Started")}</Table.Th>
								<Table.Th>{i18n._("Direction")}</Table.Th>
								<Table.Th>{i18n._("Project")}</Table.Th>
								<Table.Th>{i18n._("Status")}</Table.Th>
								<Table.Th />
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{syncs.map((sync) => {
								const direction = lookup(syncDirectionLabels, sync.direction);
								return (
									<Table.Tr key={sync.id}>
										<Table.Td>{when(sync.createdAt)}</Table.Td>
										<Table.Td>
											{direction ? i18n._(direction) : sync.direction}
										</Table.Td>
										<Table.Td>
											<Text size="sm" ff="monospace">
												{sync.project}
											</Text>
										</Table.Td>
										<Table.Td>
											{STATUSES.has(sync.status) ? (
												<DeploymentStatusBadge
													status={sync.status as DeploymentStatus}
													warningCount={sync.summary?.warnings?.length ?? 0}
												/>
											) : (
												<Badge variant="light">{sync.status}</Badge>
											)}
										</Table.Td>
										<Table.Td>
											{sync.deploymentId && (
												<Group justify="flex-end">
													<Button
														size="xs"
														variant="subtle"
														onClick={() =>
															jobs.openJob(
																sync.deploymentId ?? "",
																jobTitle(sync),
															)
														}
													>
														{i18n._("View log")}
													</Button>
												</Group>
											)}
										</Table.Td>
									</Table.Tr>
								);
							})}
						</Table.Tbody>
					</Table>
				)}
			</SectionCard>
			{exporting && (
				<CloudExportModal
					provider={exporting}
					appId={app.id}
					opened={!!exporting}
					onClose={() => setExporting(null)}
					onStarted={(deploymentId) => {
						jobs.openJob(
							deploymentId,
							i18n._("Export to {provider}", {
								provider: i18n._(exporting.label),
							}),
						);
						jobs.refresh();
					}}
				/>
			)}
			<AppJobDrawer
				job={jobs.job}
				appName={app.name}
				onClose={jobs.closeJob}
				onCompleted={() => jobs.refresh()}
			/>
		</Stack>
	);
}

/** Row counts that differ, files copied, functions and warnings of a sync. */
const SyncSummary: React.FC<{ sync: CloudSyncDTO }> = ({ sync }) => {
	const { i18n } = useLingui();
	const summary = sync.summary;
	if (!summary) return null;
	const tables = summary.tables ?? [];
	const mismatches = tables.filter((row) => row.source !== row.target);
	// `source` is where the copy came from: the cloud, or (export) this app.
	const exported = sync.direction === "export";
	const sourceLabel = exported ? i18n._("This app") : i18n._("Cloud");
	const targetLabel = exported ? i18n._("Cloud") : i18n._("This app");
	return (
		<SectionCard title={i18n._("Last sync")}>
			<Stack gap="sm">
				{summary.tables && (
					<Text size="sm">
						{mismatches.length === 0
							? i18n._(
									"{count, plural, one {# table compared} other {# tables compared}}: all row counts match.",
									{ count: tables.length },
								)
							: exported
								? i18n._(
										"{count, plural, one {# table differs} other {# tables differ}} in the cloud project:",
										{ count: mismatches.length },
									)
								: i18n._(
										"{count, plural, one {# table differs} other {# tables differ}} from the cloud project:",
										{ count: mismatches.length },
									)}
					</Text>
				)}
				{mismatches.length > 0 && (
					<Table withTableBorder fz="xs">
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{i18n._("Table")}</Table.Th>
								<Table.Th>{sourceLabel}</Table.Th>
								<Table.Th>{targetLabel}</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{mismatches.slice(0, 50).map((row) => (
								<Table.Tr key={row.table}>
									<Table.Td ff="monospace">{row.table}</Table.Td>
									<Table.Td>{row.source}</Table.Td>
									<Table.Td>{row.target}</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				)}
				{summary.buckets?.map((bucket) => (
					<Text key={bucket.bucket} size="sm">
						{i18n._(
							"Bucket {bucket}: {copied} of {total, plural, one {# object} other {# objects}} copied",
							{
								bucket: bucket.bucket,
								copied: bucket.target,
								total: bucket.source,
							},
						)}
					</Text>
				))}
				{summary.functions && summary.functions.length > 0 && (
					<Text size="sm">
						{i18n._("Edge functions: {names}", {
							names: formatList(
								i18n.locale,
								summary.functions.map((fn) =>
									fn.ok
										? fn.slug
										: i18n._("{name} (not copied)", { name: fn.slug }),
								),
							),
						})}
					</Text>
				)}
				{summary.resources && summary.resources.length > 0 && (
					<Table withTableBorder fz="xs">
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{i18n._("Resource")}</Table.Th>
								<Table.Th>{sourceLabel}</Table.Th>
								<Table.Th>{targetLabel}</Table.Th>
								<Table.Th>{i18n._("Errors")}</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{summary.resources.map((row) => (
								<Table.Tr key={row.resource}>
									<Table.Td ff="monospace">{row.resource}</Table.Td>
									<Table.Td>{formatNumber(i18n.locale, row.source)}</Table.Td>
									<Table.Td>{formatNumber(i18n.locale, row.target)}</Table.Td>
									<Table.Td>{formatNumber(i18n.locale, row.errors)}</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				)}
				{summary.notes && summary.notes.length > 0 && (
					<CodedList items={summary.notes} size="sm" />
				)}
				{summary.warnings && summary.warnings.length > 0 && (
					<CodedList items={summary.warnings} c="yellow.8" size="sm" />
				)}
			</Stack>
		</SectionCard>
	);
};
