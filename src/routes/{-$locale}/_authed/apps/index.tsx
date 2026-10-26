import { useLingui } from "@lingui/react";
import { Anchor, Button, Checkbox, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpCircle, Boxes, Plus } from "lucide-react";
import { useState } from "react";
import { AppIcon } from "#/components/apps/AppIcon";
import { AppUpdateBadge } from "#/components/apps/AppUpdateBadge";
import { BulkUpdateModal } from "#/components/apps/BulkUpdateModal";
import { useAppUpdates } from "#/components/apps/useAppUpdates";
import { AppStatusBadge } from "#/components/dashboard/StatusBadge";
import { AppHealthBadges } from "#/components/monitoring/AlertsList";
import { useCan } from "#/components/teams/useCan";
import { DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import { DATABASE_TEMPLATE_ID } from "#/config/database-engines.ts";
import { POLL_MS } from "#/config/polling.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import { alertsQueryOptions } from "#/features/monitoring/monitoring.query.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import { duplicateNames } from "#/libs/format.ts";
import { LocalizedLink } from "#/libs/i18n.ts";

export const Route = createFileRoute("/{-$locale}/_authed/apps/")({
	loader: async ({ context }) => {
		await Promise.all([
			context.queryClient.query(appsQueryOptions),
			context.queryClient.query(serversQueryOptions),
		]);
		return { crumb: context.i18n._("Apps") };
	},
	component: Apps,
});

function Apps() {
	const { i18n } = useLingui();
	const can = useCan();
	const { data: all = [] } = useQuery({
		...appsQueryOptions,
		refetchInterval: POLL_MS.list,
	});
	// Databases are listed under Data → Databases.
	const apps = all.filter((app) => app.templateId !== DATABASE_TEMPLATE_ID);
	const { data: servers = [] } = useQuery(serversQueryOptions);
	const alerts = useQuery(alertsQueryOptions());
	const duplicates = duplicateNames(apps);
	const serverName = (id: string) =>
		servers.find((server) => server.id === id)?.name ?? "";
	const updates = useAppUpdates();
	const updatable = apps.filter((app) => updates.get(app.id)?.available);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [bulkOpen, setBulkOpen] = useState(false);
	const toggle = (id: string, on: boolean) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});
	const chosen = updatable.filter((app) => selected.has(app.id));
	const canUpdate = can("app.deploy") && updatable.length > 0;

	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Apps")}
				description={i18n._("Apps deployed from templates")}
				actions={
					<Group gap="xs">
						{canUpdate && (
							<Button
								variant="light"
								leftSection={<ArrowUpCircle size={16} />}
								onClick={() => {
									if (chosen.length === 0) {
										setSelected(new Set(updatable.map((app) => app.id)));
									}
									setBulkOpen(true);
								}}
							>
								{chosen.length > 0
									? i18n._("Update selected ({count})", {
											count: chosen.length,
										})
									: i18n._("Update all ({count})", {
											count: updatable.length,
										})}
							</Button>
						)}
						<Button
							component={LocalizedLink}
							to="/apps/new"
							leftSection={<Plus size={16} />}
							display={can("app.deploy") ? undefined : "none"}
						>
							{i18n._("New app")}
						</Button>
					</Group>
				}
			/>
			<SectionCard flush>
				<DataTable
					rows={apps}
					getRowKey={(app) => app.id}
					defaultSort={{ key: "name", direction: "asc" }}
					empty={
						<EmptyState
							icon={Boxes}
							title={i18n._("No apps yet")}
							description={i18n._("Pick a template to deploy your first app.")}
						>
							{can("app.deploy") && (
								<Group gap="xs">
									<Button
										component={LocalizedLink}
										to="/apps/new"
										leftSection={<Plus size={16} />}
									>
										{i18n._("Deploy your first app")}
									</Button>
									<Button
										component={LocalizedLink}
										to="/marketplace"
										variant="default"
									>
										{i18n._("Browse the marketplace")}
									</Button>
								</Group>
							)}
						</EmptyState>
					}
					columns={[
						...(canUpdate
							? [
									{
										key: "select",
										header: "",
										render: (app: (typeof apps)[number]) =>
											updates.get(app.id)?.available ? (
												<Checkbox
													aria-label={i18n._("Select {name} for updating", {
														name: app.name,
													})}
													checked={selected.has(app.id)}
													onChange={(event) =>
														toggle(app.id, event.currentTarget.checked)
													}
												/>
											) : null,
									},
								]
							: []),
						{
							key: "name",
							header: i18n._("Name"),
							sortValue: (app) => app.name.toLowerCase(),
							render: (app) => (
								<Group
									gap="sm"
									wrap="nowrap"
									align="center"
									style={{ minWidth: 0, overflow: "hidden" }}
								>
									<AppIcon templateId={app.templateId} name={app.name} />
									<Stack
										gap={2}
										style={{ minWidth: 0, flex: 1, overflow: "hidden" }}
									>
										<Anchor
											component={LocalizedLink}
											to={`/apps/${app.id}`}
											fw={600}
											size="sm"
											truncate
										>
											{app.name}
										</Anchor>
										{duplicates.has(app.name.trim().toLowerCase()) && (
											<Text size="xs" c="dimmed" ff="monospace" truncate>
												{app.folder}
											</Text>
										)}
									</Stack>
								</Group>
							),
						},
						{
							key: "template",
							header: i18n._("Template"),
							sortValue: (app) => app.templateId,
							render: (app) => app.templateId,
						},
						{
							key: "version",
							header: i18n._("Version"),
							hideOnMobile: true,
							render: (app) => (
								<Group gap={6} wrap="nowrap">
									<Text size="sm">{app.version}</Text>
									<AppUpdateBadge update={updates.get(app.id)} compact />
								</Group>
							),
						},
						{
							key: "server",
							header: i18n._("Server"),
							hideOnMobile: true,
							sortValue: (app) => serverName(app.serverId),
							render: (app) => serverName(app.serverId),
						},
						{
							key: "status",
							header: i18n._("Status"),
							sortValue: (app) => app.status,
							render: (app) => (
								<Group gap={6} wrap="nowrap">
									<AppStatusBadge status={app.status} />
									<AppHealthBadges appId={app.id} alerts={alerts.data} />
								</Group>
							),
						},
					]}
				/>
			</SectionCard>
			<BulkUpdateModal
				opened={bulkOpen}
				onClose={() => {
					setBulkOpen(false);
					setSelected(new Set());
				}}
				apps={updatable
					.filter((app) => selected.has(app.id))
					.flatMap((app) => {
						const update = updates.get(app.id);
						return update ? [{ id: app.id, name: app.name, update }] : [];
					})}
			/>
		</Stack>
	);
}
