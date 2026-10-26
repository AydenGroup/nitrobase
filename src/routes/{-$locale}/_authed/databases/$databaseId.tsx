import { useLingui } from "@lingui/react";
import { Anchor, Center, Group, Loader, Stack, Tabs } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";
import { z } from "zod";
import { AppDeploymentsTab } from "#/components/apps/AppDeploymentsTab";
import { AppLogsTab } from "#/components/apps/AppLogsTab";
import { AppSettingsTab } from "#/components/apps/AppSettingsTab";
import { AppBackupsTab } from "#/components/backups/AppBackupsTab";
import { AppStatusBadge } from "#/components/dashboard/StatusBadge";
import { DatabaseConsoleTab } from "#/components/databases/DatabaseConsoleTab";
import { DatabaseOverviewTab } from "#/components/databases/DatabaseOverviewTab";
import { DatabaseUsersTab } from "#/components/databases/DatabaseUsersTab";
import { EngineBadge } from "#/components/databases/EngineBadge";
import { AppHealthBadges } from "#/components/monitoring/AlertsList";
import { AppMonitoringTab } from "#/components/monitoring/AppMonitoringTab";
import { useCan } from "#/components/teams/useCan";
import { NotFoundState } from "#/components/ui/NotFoundState";
import { PageHeader } from "#/components/ui/PageHeader";
import { ResourceTabs } from "#/components/ui/ResourceTabs";
import { databaseTabs } from "#/config/database-tabs.ts";
import { pollWhile } from "#/config/polling.ts";
import { appStatuses, isBusy } from "#/config/status.ts";
import { appQueryOptions } from "#/features/apps/apps.query.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import { databaseQueryOptions } from "#/features/databases/databases.query.ts";
import type { DatabaseOverview } from "#/features/databases/schema.ts";
import { alertsQueryOptions } from "#/features/monitoring/monitoring.query.ts";
import { LocalizedLink } from "#/libs/i18n.ts";

const SearchSchema = z.object({
	tab: z.string().optional(),
	/** Job to open in the log drawer (e.g. right after creating). */
	job: z.string().optional(),
});

export const Route = createFileRoute(
	"/{-$locale}/_authed/databases/$databaseId",
)({
	validateSearch: SearchSchema,
	loader: async ({ context, params }) => {
		if (!z.guid().safeParse(params.databaseId).success) throw notFound();
		const database = await context.queryClient
			.query(databaseQueryOptions(params.databaseId))
			.catch(() => null);
		if (!database) throw notFound();
		await context.queryClient
			.query(appQueryOptions(params.databaseId))
			.catch(() => null);
		return { crumb: database.name };
	},
	component: DatabaseDetail,
	notFoundComponent: () => {
		const { i18n } = useLingui();
		return (
			<NotFoundState
				title={i18n._("Database not found")}
				description={i18n._("The database you are looking for does not exist.")}
			/>
		);
	},
});

type TabProps = { overview: AppOverview; database: DatabaseOverview };

/** Tab id -> component (database tabs, then the app tabs a database reuses). */
const tabComponents: Record<string, React.ComponentType<TabProps>> = {
	overview: DatabaseOverviewTab,
	console: DatabaseConsoleTab,
	users: DatabaseUsersTab,
	backups: AppBackupsTab,
	monitoring: AppMonitoringTab,
	logs: AppLogsTab,
	deployments: AppDeploymentsTab,
	settings: AppSettingsTab,
};

function DatabaseDetail() {
	const { i18n } = useLingui();
	const { databaseId } = Route.useParams();
	const { tab = "overview" } = Route.useSearch();
	const navigate = Route.useNavigate();
	const app = useQuery({
		...appQueryOptions(databaseId),
		refetchInterval: (query) =>
			pollWhile(isBusy(appStatuses, query.state.data?.app.status)),
	});
	const database = useQuery({
		...databaseQueryOptions(databaseId),
		refetchInterval: (query) =>
			pollWhile(isBusy(appStatuses, query.state.data?.status)),
	});
	const alerts = useQuery(alertsQueryOptions({ appId: databaseId }));
	const can = useCan();
	if (!app.data || !database.data) return null;
	const overview = app.data;
	const data = database.data;
	const tabs = databaseTabs.filter(
		(item) =>
			(!item.permission || can(item.permission)) &&
			(!item.needsUsers || data.manageUsers),
	);

	return (
		<Stack gap="lg">
			<PageHeader
				title={data.name}
				badge={
					<Group gap={6} wrap="nowrap">
						<AppStatusBadge status={overview.app.status} />
						<AppHealthBadges appId={databaseId} alerts={alerts.data} />
					</Group>
				}
				description={
					<Group gap={6} wrap="wrap">
						<EngineBadge engine={data.engine} version={data.tag} />
						<span>·</span>
						<Anchor
							component={LocalizedLink}
							to={`/servers/${data.server.id}`}
							size="sm"
						>
							{data.server.name}
						</Anchor>
					</Group>
				}
			/>
			<ResourceTabs
				value={tab}
				onChange={(value) =>
					navigate({ search: { tab: value }, replace: true })
				}
				items={tabs.map((item) => ({
					id: item.id,
					label: i18n._(item.label),
					icon: item.icon,
					section: item.id === "settings" ? { id: "settings" } : undefined,
				}))}
			>
				{tabs.map((item) => {
					const Component = tabComponents[item.id];
					return Component ? (
						<Tabs.Panel key={item.id} value={item.id}>
							<Suspense
								fallback={
									<Center p="xl">
										<Loader size="sm" />
									</Center>
								}
							>
								<Component overview={overview} database={data} />
							</Suspense>
						</Tabs.Panel>
					) : null;
				})}
			</ResourceTabs>
		</Stack>
	);
}
