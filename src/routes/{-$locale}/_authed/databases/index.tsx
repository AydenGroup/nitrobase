import { useLingui } from "@lingui/react";
import {
	Anchor,
	Badge,
	Button,
	Group,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Database, Plus } from "lucide-react";
import { AppUpdateBadge } from "#/components/apps/AppUpdateBadge";
import { useAppUpdates } from "#/components/apps/useAppUpdates";
import { AppStatusBadge } from "#/components/dashboard/StatusBadge";
import { EngineBadge } from "#/components/databases/EngineBadge";
import { useCan } from "#/components/teams/useCan";
import { DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import { POLL_MS } from "#/config/polling.ts";
import {
	databaseSizeQueryOptions,
	databasesQueryOptions,
} from "#/features/databases/databases.query.ts";
import type { DatabaseListItem } from "#/features/databases/schema.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatBytes } from "#/libs/intl.ts";

export const Route = createFileRoute("/{-$locale}/_authed/databases/")({
	loader: async ({ context }) => {
		await context.queryClient.query(databasesQueryOptions()).catch(() => null);
		return { crumb: context.i18n._("Databases") };
	},
	component: Databases,
});

/** Measured size, loaded per row (cached server side). */
const SizeCell: React.FC<{ item: DatabaseListItem }> = ({ item }) => {
	const { i18n } = useLingui();
	const size = useQuery({
		...databaseSizeQueryOptions(item.id),
		enabled: item.status === "running",
	});
	const bytes = size.data?.sizeBytes;
	return (
		<Text size="sm" c={bytes == null ? "dimmed" : undefined}>
			{bytes == null ? "—" : formatBytes(i18n.locale, bytes)}
		</Text>
	);
};

function Databases() {
	const { i18n } = useLingui();
	const can = useCan();
	const updates = useAppUpdates();
	const { data: databases = [] } = useQuery({
		...databasesQueryOptions(),
		refetchInterval: POLL_MS.list,
	});
	const createButton = (
		<Button
			component={LocalizedLink}
			to="/databases/new"
			leftSection={<Plus size={16} />}
		>
			{i18n._("New database")}
		</Button>
	);
	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Databases")}
				description={i18n._(
					"Standalone databases with backups, a console and private links to your apps",
				)}
				actions={can("database.manage") ? createButton : undefined}
			/>
			<SectionCard flush>
				<DataTable
					rows={databases}
					getRowKey={(item) => item.id}
					defaultSort={{ key: "name", direction: "asc" }}
					empty={
						<EmptyState
							icon={Database}
							title={i18n._("No databases yet")}
							description={i18n._(
								"Create a PostgreSQL, MySQL, MariaDB, Valkey or MongoDB database, then link it to your apps.",
							)}
						>
							{can("database.manage") && createButton}
						</EmptyState>
					}
					columns={[
						{
							key: "name",
							header: i18n._("Name"),
							sortValue: (item) => item.name.toLowerCase(),
							render: (item) => (
								<Anchor
									component={LocalizedLink}
									to={`/databases/${item.id}`}
									fw={600}
									size="sm"
								>
									{item.name}
								</Anchor>
							),
						},
						{
							key: "engine",
							header: i18n._("Engine"),
							sortValue: (item) => item.engine,
							render: (item) => (
								<Group gap={6} wrap="nowrap">
									<EngineBadge engine={item.engine} version={item.tag} />
									<AppUpdateBadge update={updates.get(item.id)} compact />
								</Group>
							),
						},
						{
							key: "server",
							header: i18n._("Server"),
							hideOnMobile: true,
							sortValue: (item) => item.serverName,
							render: (item) => item.serverName,
						},
						{
							key: "size",
							header: i18n._("Size"),
							hideOnMobile: true,
							render: (item) => <SizeCell item={item} />,
						},
						{
							key: "links",
							header: i18n._("Linked apps"),
							hideOnMobile: true,
							sortValue: (item) => item.links,
							render: (item) => (
								<Group gap={6} wrap="nowrap">
									<Text size="sm">{item.links}</Text>
									{item.exposed && (
										<Tooltip
											label={i18n._("The port is published on the server")}
											withArrow
										>
											<Badge size="xs" color="orange" variant="light">
												{i18n._("Published")}
											</Badge>
										</Tooltip>
									)}
								</Group>
							),
						},
						{
							key: "status",
							header: i18n._("Status"),
							sortValue: (item) => item.status,
							render: (item) => (
								<Group gap={6} wrap="nowrap">
									<AppStatusBadge status={item.status} />
									{item.needsRedeploy && (
										<Badge size="xs" color="yellow" variant="light">
											{i18n._("Needs redeploy")}
										</Badge>
									)}
								</Group>
							),
						},
					]}
				/>
			</SectionCard>
		</Stack>
	);
}
