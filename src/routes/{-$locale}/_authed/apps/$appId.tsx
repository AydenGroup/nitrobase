import { useLingui } from "@lingui/react";
import { Anchor, Center, Group, Loader, Stack, Tabs } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { z } from "zod";
import { AppDeploymentsTab } from "#/components/apps/AppDeploymentsTab";
import { AppDomainsTab } from "#/components/apps/AppDomainsTab";
import { AppEnvTab } from "#/components/apps/AppEnvTab";
import { AppLogsTab } from "#/components/apps/AppLogsTab";
import { AppOverviewTab } from "#/components/apps/AppOverviewTab";
import { AppTerminalTab } from "#/components/apps/AppPlaceholderTabs";
import { AppSettingsTab } from "#/components/apps/AppSettingsTab";
import { AppBackupsTab } from "#/components/backups/AppBackupsTab";
import { AppStatusBadge } from "#/components/dashboard/StatusBadge";
import { AppHealthBadges } from "#/components/monitoring/AlertsList";
import { AppMonitoringTab } from "#/components/monitoring/AppMonitoringTab";
import { useCan } from "#/components/teams/useCan";
import { NotFoundState } from "#/components/ui/NotFoundState";
import { PageHeader } from "#/components/ui/PageHeader";
import { ResourceTabs } from "#/components/ui/ResourceTabs";
import { tabsForTemplate } from "#/config/app-tabs.ts";
import { pollWhile } from "#/config/polling.ts";
import { appStatuses, isBusy } from "#/config/status.ts";
import { appQueryOptions } from "#/features/apps/apps.query.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import { alertsQueryOptions } from "#/features/monitoring/monitoring.query.ts";
import { LocalizedLink, translateTemplateText } from "#/libs/i18n.ts";
import { providerPlugins } from "#/plugins/registry.ts";

const SearchSchema = z.object({
	tab: z.string().optional(),
	/** Job to open in the log drawer (e.g. right after deploying). */
	job: z.string().optional(),
});

export const Route = createFileRoute("/{-$locale}/_authed/apps/$appId")({
	validateSearch: SearchSchema,
	loader: async ({ context, params, location }) => {
		if (!z.guid().safeParse(params.appId).success) throw notFound();
		const overview = await context.queryClient
			.query(appQueryOptions(params.appId))
			.catch(() => null);
		if (!overview) throw notFound();
		// Databases have their own page.
		if (overview.sourceKind === "database") {
			throw redirect({
				to: "/{-$locale}/databases/$databaseId",
				params: { locale: params.locale, databaseId: params.appId },
				search: location.search as never,
			});
		}
		return { crumb: overview.app.name };
	},
	component: AppDetail,
	notFoundComponent: () => {
		const { i18n } = useLingui();
		return (
			<NotFoundState
				title={i18n._("App not found")}
				description={i18n._("The app you are looking for does not exist.")}
			/>
		);
	},
});

/** The app's Monitoring tab, where one service can be restarted. */
const AppMonitoringWithRestart: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => <AppMonitoringTab overview={overview} serviceRestart />;

/** Tab id -> component: built-in tabs, then lazy provider plugin tabs. */
const tabComponents: Record<
	string,
	React.ComponentType<{ overview: AppOverview }>
> = {
	overview: AppOverviewTab,
	deployments: AppDeploymentsTab,
	logs: AppLogsTab,
	environment: AppEnvTab,
	domains: AppDomainsTab,
	backups: AppBackupsTab,
	monitoring: AppMonitoringWithRestart,
	terminal: AppTerminalTab,
	settings: AppSettingsTab,
	...Object.fromEntries(
		providerPlugins.flatMap((plugin) =>
			plugin.tabs.map((tab) => [tab.id, lazy(tab.load)]),
		),
	),
};

function AppDetail() {
	const { i18n } = useLingui();
	const { appId } = Route.useParams();
	const { tab = "overview" } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { data } = useQuery({
		...appQueryOptions(appId),
		// Poll while something is in flight so the status follows the job.
		refetchInterval: (query) =>
			pollWhile(isBusy(appStatuses, query.state.data?.app.status)),
	});
	const alerts = useQuery(alertsQueryOptions({ appId }));
	const can = useCan();
	if (!data) return null;
	const tabs = tabsForTemplate(data.app.templateId).filter(
		(item) => !item.permission || can(item.permission),
	);
	const templateName = translateTemplateText(i18n, data.templateName);

	return (
		<Stack gap="lg">
			<PageHeader
				title={data.app.name}
				badge={
					<Group gap={6} wrap="nowrap">
						<AppStatusBadge
							status={data.app.status}
							notRunning={data.usage?.notRunning}
						/>
						<AppHealthBadges appId={data.app.id} alerts={alerts.data} />
					</Group>
				}
				description={
					<>
						{templateName}{" "}
						{data.sourceKind === "git"
							? (data.app.commitSha?.slice(0, 12) ?? "")
							: data.app.version}{" "}
						·{" "}
						<Anchor
							component={LocalizedLink}
							to={`/servers/${data.server.id}`}
							size="sm"
						>
							{data.server.name}
						</Anchor>
						{data.primaryUrl && (
							<>
								{" · "}
								<Anchor
									href={data.primaryUrl}
									target="_blank"
									rel="noreferrer"
									size="sm"
								>
									{data.primaryUrl}
								</Anchor>
							</>
						)}
					</>
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
					section: item.plugin
						? { id: "plugin", label: templateName }
						: item.id === "settings"
							? { id: "settings" }
							: undefined,
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
								<Component overview={data} />
							</Suspense>
						</Tabs.Panel>
					) : null;
				})}
			</ResourceTabs>
		</Stack>
	);
}
