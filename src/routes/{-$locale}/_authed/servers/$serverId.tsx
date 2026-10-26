import { useLingui } from "@lingui/react";
import { Badge, Button, Stack, Tabs } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { TerminalSquare } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { JobsTable } from "#/components/jobs/JobsTable";
import {
	ServerLiveStatusBadge,
	useUnreachableServers,
} from "#/components/monitoring/ServerLiveStatus";
import { ServerMonitoringTab } from "#/components/monitoring/ServerMonitoringTab";
import { TerminalDrawer } from "#/components/servers/TerminalDrawer";
import { ServerAppsTab } from "#/components/servers/tabs/ServerAppsTab";
import { ServerOverviewTab } from "#/components/servers/tabs/ServerOverviewTab";
import { ServerSettingsTab } from "#/components/servers/tabs/ServerSettingsTab";
import { useCan } from "#/components/teams/useCan";
import { EmptyState } from "#/components/ui/EmptyState";
import { NotFoundState } from "#/components/ui/NotFoundState";
import { PageHeader } from "#/components/ui/PageHeader";
import { ResourceTabs } from "#/components/ui/ResourceTabs";
import { SectionCard } from "#/components/ui/SectionCard";
import { pollWhile } from "#/config/polling.ts";
import { serverTabs } from "#/config/server-tabs.ts";
import { isBusy, serverStatuses, sessionJobTypes } from "#/config/status.ts";
import { jobsQueryOptions } from "#/features/deployments/deployments.query.ts";
import { serverQueryOptions } from "#/features/servers/servers.query.ts";

/**
 * Server detail page with tabs (selected via `?tab=`). The loader fetches the
 * server (ownership is enforced server-side) and 404s when it is missing;
 * the server name doubles as the breadcrumb label.
 */
export const Route = createFileRoute("/{-$locale}/_authed/servers/$serverId")({
	validateSearch: z.object({ tab: z.string().optional() }),
	loader: async ({ context, params }) => {
		const server = await context.queryClient.query(
			serverQueryOptions(params.serverId),
		);
		if (!server) throw notFound();
		return { crumb: server.name, server };
	},
	component: ServerDetail,
	notFoundComponent: () => {
		const { i18n } = useLingui();
		return (
			<NotFoundState
				title={i18n._("Server not found")}
				description={i18n._("The server you are looking for does not exist.")}
			/>
		);
	},
});

function ServerDetail() {
	const { i18n } = useLingui();
	const loaderData = Route.useLoaderData();
	const { tab = "overview" } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { data: liveServer } = useQuery({
		...serverQueryOptions(loaderData.server.id),
		refetchInterval: (query) =>
			pollWhile(isBusy(serverStatuses, query.state.data?.status)),
	});
	const server = liveServer ?? loaderData.server;
	const jobs = useQuery(jobsQueryOptions({ serverId: server.id, limit: 50 }));
	const busy = (jobs.data ?? []).some(
		(job) => job.status === "running" && !sessionJobTypes.has(job.type),
	);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const can = useCan();
	const unreachable = useUnreachableServers();
	const setTab = (value: string) =>
		navigate({ search: { tab: value }, replace: true });

	return (
		<Stack gap="lg">
			<PageHeader
				title={server.name}
				badge={
					<ServerLiveStatusBadge server={server} unreachable={unreachable} />
				}
				description={
					<>
						{server.isDefault
							? i18n._("Local host")
							: `${server.username}@${server.host}:${server.port}`}
						{server.isDefault && (
							<Badge ml="xs" size="xs" variant="light" color="violet">
								{i18n._("Default")}
							</Badge>
						)}
					</>
				}
				actions={
					can("server.terminal") && (
						<Button
							variant="default"
							leftSection={<TerminalSquare size={16} />}
							onClick={() => setTerminalOpen(true)}
						>
							{i18n._("Terminal")}
						</Button>
					)
				}
			/>
			<ResourceTabs
				value={tab}
				onChange={setTab}
				items={serverTabs
					.filter((item) => !item.permission || can(item.permission))
					.map((item) => ({
						id: item.id,
						label: i18n._(item.label),
						icon: item.icon,
						section: item.id === "settings" ? { id: "settings" } : undefined,
					}))}
			>
				<Tabs.Panel value="overview">
					<ServerOverviewTab
						server={server}
						busy={busy}
						onEdit={() => setTab("settings")}
					/>
				</Tabs.Panel>
				<Tabs.Panel value="apps">
					<ServerAppsTab
						serverId={server.id}
						ready={server.status === "ready"}
					/>
				</Tabs.Panel>
				<Tabs.Panel value="jobs">
					<SectionCard flush>
						<JobsTable
							jobs={jobs.data ?? []}
							loading={jobs.isLoading}
							onCompleted={() => jobs.refetch()}
						/>
					</SectionCard>
				</Tabs.Panel>
				<Tabs.Panel value="terminal">
					<SectionCard>
						<EmptyState
							compact
							icon={TerminalSquare}
							title={i18n._("Server terminal")}
							description={i18n._(
								"A root shell on this server. Sessions close after being idle and are recorded in the job list.",
							)}
						>
							<Button mt="xs" onClick={() => setTerminalOpen(true)}>
								{i18n._("Open terminal")}
							</Button>
						</EmptyState>
					</SectionCard>
				</Tabs.Panel>
				<Tabs.Panel value="monitoring">
					<ServerMonitoringTab
						serverId={server.id}
						ready={server.status === "ready"}
					/>
				</Tabs.Panel>
				<Tabs.Panel value="settings">
					<ServerSettingsTab server={server} busy={busy} />
				</Tabs.Panel>
			</ResourceTabs>
			{/* Terminal sessions are recorded as jobs, so closing refreshes the list. */}
			<TerminalDrawer
				opened={terminalOpen}
				onClose={() => {
					setTerminalOpen(false);
					jobs.refetch();
				}}
				wsPath={`/api/servers/${encodeURIComponent(server.id)}/terminal`}
				serverName={server.name}
			/>
		</Stack>
	);
}
