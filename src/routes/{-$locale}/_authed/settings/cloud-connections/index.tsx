import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Anchor,
	Badge,
	Button,
	Group,
	Menu,
	Stack,
	Text,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	CheckCircle2,
	CircleX,
	Cloud,
	MoreHorizontal,
	Plus,
} from "lucide-react";
import { useState } from "react";
import { CloudConnectionFormModal } from "#/components/cloud-sync/CloudConnectionFormModal";
import { ConnectionTestDetails } from "#/components/cloud-sync/ConnectionTestDetails";
import { useCan } from "#/components/teams/useCan";
import { DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { getCloudSyncProvider } from "#/config/cloud-sync.ts";
import type { CloudConnectionTestRecord } from "#/db/schema/cloud-sync.ts";
import {
	deleteCloudConnectionFn,
	testCloudConnectionFn,
} from "#/features/cloud-sync/cloud-sync.functions.ts";
import { cloudConnectionsQueryOptions } from "#/features/cloud-sync/cloud-sync.query.ts";
import type { CloudConnectionDTO } from "#/features/cloud-sync/schema.ts";
import { formatDate } from "#/libs/intl.ts";

export const Route = createFileRoute(
	"/{-$locale}/_authed/settings/cloud-connections/",
)({
	loader: async ({ context }) => {
		await context.queryClient
			.query(cloudConnectionsQueryOptions)
			.catch(() => undefined);
		return { crumb: context.i18n._("Cloud connections") };
	},
	component: CloudConnections,
});

function CloudConnections() {
	const { i18n } = useLingui();
	const manage = useCan()("cloud_connection.manage");
	const queryClient = useQueryClient();
	const { data: connections = [], isLoading } = useQuery(
		cloudConnectionsQueryOptions,
	);
	const [editing, setEditing] = useState<CloudConnectionDTO | null | undefined>(
		undefined,
	);
	const [results, setResults] = useState<
		Record<string, CloudConnectionTestRecord>
	>({});

	const showDetails = (
		connectionProvider: string,
		result: CloudConnectionTestRecord,
	) =>
		modals.open({
			title: i18n._("Test details"),
			size: "lg",
			children: (
				<ConnectionTestDetails
					provider={getCloudSyncProvider(connectionProvider)}
					result={result}
				/>
			),
		});

	const test = useAppMutation({
		mutationFn: async (id: string) => ({
			id,
			result: await testCloudConnectionFn({ data: { id } }),
		}),
		success: ({ result }) =>
			result.ok ? i18n._("The connection works") : null,
		onSuccess: ({ id, result }) => {
			setResults((prev) => ({ ...prev, [id]: result }));
			const connection = connections.find((row) => row.id === id);
			const refused = result.directions.some((item) => !item.ok);
			if (connection && (!result.ok || refused || result.warnings.length)) {
				showDetails(connection.provider, result);
			}
		},
	});
	const remove = useAppMutation({
		mutationFn: async (id: string) =>
			await deleteCloudConnectionFn({ data: { id } }),
		success: i18n._("Connection deleted"),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: cloudConnectionsQueryOptions.queryKey,
			}),
	});
	const confirmDelete = (connection: CloudConnectionDTO) =>
		modals.openConfirmModal({
			title: i18n._("Delete connection"),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._(
						"{name} and its credentials are removed. Apps imported with it keep running; their sync history keeps its name.",
						{ name: connection.name },
					)}
				</Text>
			),
			labels: { confirm: i18n._("Delete"), cancel: i18n._("Cancel") },
			confirmProps: { color: "red" },
			onConfirm: () => remove.mutate(connection.id),
		});

	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Cloud connections")}
				description={i18n._(
					"Hosted projects (such as Supabase or Appwrite Cloud) to import into a new app, or to export an app into. Credentials stay encrypted on this instance.",
				)}
				actions={
					manage && (
						<Button
							leftSection={<Plus size={16} />}
							onClick={() => setEditing(null)}
						>
							{i18n._("Add connection")}
						</Button>
					)
				}
			/>
			<SectionCard flush>
				<DataTable
					rows={connections}
					loading={isLoading}
					getRowKey={(row) => row.id}
					defaultSort={{ key: "name", direction: "asc" }}
					empty={
						<EmptyState
							icon={Cloud}
							title={i18n._("No cloud connections yet")}
							description={i18n._(
								"Add a connection, test it, then import the project from Apps → New app, or export an app from its Cloud sync tab.",
							)}
							actionLabel={manage ? i18n._("Add connection") : undefined}
							action={manage ? () => setEditing(null) : undefined}
						/>
					}
					columns={[
						{
							key: "name",
							header: i18n._("Name"),
							sortValue: (row) => row.name,
							render: (row) => (
								<Text size="sm" fw={500}>
									{row.name}
								</Text>
							),
						},
						{
							key: "provider",
							header: i18n._("Provider"),
							render: (row) => {
								const provider = getCloudSyncProvider(row.provider);
								return (
									<Badge variant="light" color="gray">
										{provider ? i18n._(provider.label) : row.provider}
									</Badge>
								);
							},
						},
						{
							key: "project",
							header: i18n._("Project"),
							hideOnMobile: true,
							render: (row) => {
								const field = getCloudSyncProvider(row.provider)?.projectField;
								return (
									<Text size="sm" ff="monospace">
										{field ? String(row.config[field] ?? "—") : "—"}
									</Text>
								);
							},
						},
						{
							key: "test",
							header: i18n._("Last test"),
							hideOnMobile: true,
							render: (row) => {
								const result = results[row.id] ?? row.lastTest;
								if (!result) return "—";
								return (
									<Group gap={4} wrap="nowrap">
										{result.ok ? (
											<CheckCircle2
												size={16}
												color="var(--mantine-color-green-6)"
											/>
										) : (
											<CircleX size={16} color="var(--mantine-color-red-6)" />
										)}
										<Anchor
											size="xs"
											component="button"
											c={result.ok ? "dimmed" : "red"}
											onClick={() => showDetails(row.provider, result)}
										>
											{formatDate(i18n.locale, result.at)}
										</Anchor>
									</Group>
								);
							},
						},
						{
							key: "actions",
							header: "",
							align: "right",
							render: (row) => (
								<Group
									gap={4}
									justify="flex-end"
									wrap="nowrap"
									display={manage ? undefined : "none"}
								>
									<Button
										size="xs"
										variant="light"
										loading={test.isPending && test.variables === row.id}
										onClick={() => test.mutate(row.id)}
									>
										{i18n._("Test")}
									</Button>
									<Menu position="bottom-end">
										<Menu.Target>
											<ActionIcon
												variant="subtle"
												aria-label={i18n._("More actions")}
											>
												<MoreHorizontal size={16} />
											</ActionIcon>
										</Menu.Target>
										<Menu.Dropdown>
											<Menu.Item onClick={() => setEditing(row)}>
												{i18n._("Edit")}
											</Menu.Item>
											<Menu.Item color="red" onClick={() => confirmDelete(row)}>
												{i18n._("Delete")}
											</Menu.Item>
										</Menu.Dropdown>
									</Menu>
								</Group>
							),
						},
					]}
				/>
			</SectionCard>
			<CloudConnectionFormModal
				opened={editing !== undefined}
				onClose={() => setEditing(undefined)}
				connection={editing}
			/>
		</Stack>
	);
}
