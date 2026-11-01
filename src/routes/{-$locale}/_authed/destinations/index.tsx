import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Anchor,
	Badge,
	Button,
	Group,
	Menu,
	Select,
	Stack,
	Text,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	CheckCircle2,
	CircleX,
	HardDrive,
	MoreHorizontal,
	Plus,
} from "lucide-react";
import { useState } from "react";
import { DestinationFormModal } from "#/components/backups/DestinationFormModal";
import { DestinationTestDetails } from "#/components/backups/DestinationTestDetails";
import { useCan } from "#/components/teams/useCan";
import { DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	getDestinationDriver,
	rcloneErrorLabels,
} from "#/config/backup-drivers.ts";
import { APP_NAME } from "#/config/shared.ts";
import {
	deleteDestinationFn,
	testDestinationFn,
} from "#/features/backups/backups.functions.ts";
import { destinationsQueryOptions } from "#/features/backups/backups.query.ts";
import type {
	DestinationDTO,
	DestinationTestResult,
} from "#/features/backups/schema.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import { formatDate } from "#/libs/intl.ts";

export const Route = createFileRoute("/{-$locale}/_authed/destinations/")({
	loader: async ({ context }) => {
		await context.queryClient
			.query(destinationsQueryOptions)
			.catch(() => undefined);
		return { crumb: context.i18n._("Destinations") };
	},
	component: Destinations,
});

function Destinations() {
	const { i18n } = useLingui();
	const manage = useCan()("destination.manage");
	const queryClient = useQueryClient();
	const { data: destinations = [], isLoading } = useQuery(
		destinationsQueryOptions,
	);
	const { data: servers = [] } = useQuery(serversQueryOptions);
	const readyServers = servers.filter((server) => server.status === "ready");
	const [editing, setEditing] = useState<DestinationDTO | null | undefined>(
		undefined,
	);
	const [testServer, setTestServer] = useState<string | null>(null);
	const [results, setResults] = useState<Record<string, DestinationTestResult>>(
		{},
	);

	const test = useAppMutation({
		mutationFn: async (id: string) => ({
			id,
			result: await testDestinationFn({
				data: { id, serverId: testServer ?? undefined },
			}),
		}),
		success: ({ result }) =>
			result.ok ? i18n._("Destination works (write, read, delete)") : null,
		onSuccess: ({ id, result }) =>
			setResults((prev) => ({ ...prev, [id]: result })),
	});
	const remove = useAppMutation({
		mutationFn: async (id: string) =>
			await deleteDestinationFn({ data: { id } }),
		success: i18n._("Destination deleted"),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: destinationsQueryOptions.queryKey,
			}),
	});
	const confirmDelete = (destination: DestinationDTO) =>
		modals.openConfirmModal({
			title: i18n._("Delete destination"),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._(
						"{name} is removed from {appName}. Files already stored there are not touched.",
						{ appName: APP_NAME, name: destination.name },
					)}
				</Text>
			),
			labels: { confirm: i18n._("Delete"), cancel: i18n._("Cancel") },
			confirmProps: { color: "red" },
			onConfirm: () => remove.mutate(destination.id),
		});

	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Destinations")}
				description={i18n._(
					"Where backups are stored: a folder on the server, S3-compatible storage, Cloudflare R2 or Backblaze B2.",
				)}
				actions={
					manage && (
						<Button
							leftSection={<Plus size={16} />}
							onClick={() => setEditing(null)}
						>
							{i18n._("Add destination")}
						</Button>
					)
				}
			/>
			<SectionCard
				flush
				actions={
					destinations.length > 0 ? (
						<Select
							size="xs"
							w={220}
							aria-label={i18n._("Test from server")}
							placeholder={i18n._("Test from: first ready server")}
							data={readyServers.map((server) => ({
								value: server.id,
								label: server.name,
							}))}
							value={testServer}
							onChange={setTestServer}
							clearable
						/>
					) : undefined
				}
				title={destinations.length > 0 ? i18n._("Destinations") : undefined}
			>
				<DataTable
					rows={destinations}
					loading={isLoading}
					getRowKey={(row) => row.id}
					defaultSort={{ key: "name", direction: "asc" }}
					empty={
						<EmptyState
							icon={HardDrive}
							title={i18n._("No destinations yet")}
							description={i18n._(
								"Add a destination, test it, then schedule backups from each app's Backups tab.",
							)}
							actionLabel={manage ? i18n._("Add destination") : undefined}
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
							key: "type",
							header: i18n._("Type"),
							render: (row) => {
								const driver = getDestinationDriver(row.type);
								return (
									<Group gap={4} wrap="nowrap">
										<Badge variant="light" color="gray">
											{driver ? i18n._(driver.label) : row.type}
										</Badge>
										{driver?.capabilities.onServer && (
											<Badge variant="outline" color="yellow" size="sm">
												{i18n._("not off-site")}
											</Badge>
										)}
									</Group>
								);
							},
						},
						{
							key: "backups",
							header: i18n._("Backups"),
							sortValue: (row) => row.backups,
							render: (row) => row.backups,
						},
						{
							key: "test",
							header: i18n._("Last test"),
							hideOnMobile: true,
							render: (row) => {
								const result = results[row.id] ?? row.lastTest;
								if (!result) return "—";
								const when = formatDate(i18n.locale, result.at);
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
										<Text
											size="xs"
											c={result.ok ? "dimmed" : "red"}
											lineClamp={2}
											title={when}
										>
											{result.ok
												? i18n._("OK from {server}", {
														server: result.serverName,
													})
												: i18n._(
														rcloneErrorLabels[result.kind ?? "unknown"] ??
															rcloneErrorLabels.unknown,
													)}
										</Text>
										{!result.ok && result.detail && (
											<Anchor
												size="xs"
												component="button"
												onClick={() =>
													modals.open({
														title: i18n._("Test details"),
														size: "lg",
														children: (
															<DestinationTestDetails result={result} />
														),
													})
												}
											>
												{i18n._("Details")}
											</Anchor>
										)}
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
			<DestinationFormModal
				opened={editing !== undefined}
				onClose={() => setEditing(undefined)}
				destination={editing}
			/>
		</Stack>
	);
}
