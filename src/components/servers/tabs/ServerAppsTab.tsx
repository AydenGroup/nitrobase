import { useLingui } from "@lingui/react";
import { Anchor, Button, Group } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, Plus } from "lucide-react";
import { AppIcon } from "#/components/apps/AppIcon";
import { DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { SectionCard } from "#/components/ui/SectionCard";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { appStatuses } from "#/config/status.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import { LocalizedLink } from "#/libs/i18n.ts";

export const ServerAppsTab: React.FC<{ serverId: string; ready: boolean }> = ({
	serverId,
	ready,
}) => {
	const { i18n } = useLingui();
	const { data: apps = [], isLoading } = useQuery(appsQueryOptions);
	const rows = apps.filter((app) => app.serverId === serverId);
	return (
		<SectionCard
			flush
			title={i18n._("Apps on this server")}
			actions={
				ready ? (
					<Button
						component={LocalizedLink}
						to="/apps/new"
						size="xs"
						leftSection={<Plus size={14} />}
					>
						{i18n._("New app")}
					</Button>
				) : undefined
			}
		>
			<DataTable
				rows={rows}
				loading={isLoading}
				getRowKey={(app) => app.id}
				empty={
					<EmptyState
						compact
						icon={AppWindow}
						title={i18n._("No apps yet")}
						description={
							ready
								? i18n._("Pick a template to deploy your first app.")
								: i18n._("Bootstrap this server first, then deploy apps to it.")
						}
					>
						{ready && (
							<Button
								component={LocalizedLink}
								to="/apps/new"
								size="xs"
								leftSection={<Plus size={14} />}
							>
								{i18n._("Deploy an app")}
							</Button>
						)}
					</EmptyState>
				}
				columns={[
					{
						key: "name",
						header: i18n._("Name"),
						sortValue: (app) => app.name,
						render: (app) => (
							<Group
								gap="sm"
								wrap="nowrap"
								align="center"
								style={{ minWidth: 0, overflow: "hidden" }}
							>
								<AppIcon templateId={app.templateId} name={app.name} />
								<Anchor
									component={LocalizedLink}
									to={`/apps/${app.id}`}
									fw={600}
									size="sm"
									truncate
								>
									{app.name}
								</Anchor>
							</Group>
						),
					},
					{
						key: "template",
						header: i18n._("Template"),
						render: (app) => app.templateId,
					},
					{
						key: "version",
						header: i18n._("Version"),
						hideOnMobile: true,
						render: (app) => app.version,
					},
					{
						key: "status",
						header: i18n._("Status"),
						sortValue: (app) => app.status,
						render: (app) => <StatusBadge meta={appStatuses[app.status]} />,
					},
				]}
			/>
		</SectionCard>
	);
};
