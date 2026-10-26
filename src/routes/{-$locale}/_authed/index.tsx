import { useLingui } from "@lingui/react";
import {
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Center,
	Group,
	type MantineColor,
	RingProgress,
	SimpleGrid,
	Stack,
	Text,
	ThemeIcon,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	Activity,
	AppWindow,
	BellRing,
	Database,
	Globe,
	HardDrive,
	Plus,
	Server,
} from "lucide-react";
import { InstanceUpdateBanner } from "#/components/dashboard/InstanceUpdateBanner";
import { OnboardingChecklist } from "#/components/dashboard/OnboardingChecklist";
import {
	StatCard,
	statusBreakdown,
	worstTone,
} from "#/components/dashboard/StatCard";
import { UpdatesCard } from "#/components/dashboard/UpdatesCard";
import { getJobVisual } from "#/components/jobs/JobsTable";
import { AlertsList } from "#/components/monitoring/AlertsList";
import {
	ServerLiveStatusBadge,
	unreachableServerIds,
} from "#/components/monitoring/ServerLiveStatus";
import { useCan } from "#/components/teams/useCan";
import { DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { LocalDate } from "#/components/ui/LocalDate";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import { StatusBadge, StatusDot } from "#/components/ui/StatusBadge";
import { storedCheckText } from "#/config/check-details.ts";
import { domainCheckLabel } from "#/config/domain-checks.ts";
import { titleFor } from "#/config/job-titles.ts";
import {
	appStatuses,
	deploymentStatuses,
	domainCheckStatuses,
	isUnusedLocalServer,
} from "#/config/status.ts";
import type { AppStatus } from "#/features/apps/schema.ts";
import { dashboardQueryOptions } from "#/features/dashboard/dashboard.query.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatPercent, formatPercentPoints } from "#/libs/intl.ts";
import { type StatusTone, toneColors } from "#/theme/tokens.ts";

/**
 * Dashboard (home). The loader prefetches the summary but swallows errors,
 * so a failed fetch leaves an empty page rather than the error boundary.
 */
export const Route = createFileRoute("/{-$locale}/_authed/")({
	loader: async ({ context }) => {
		await context.queryClient.query(dashboardQueryOptions).catch(() => null);
		return { crumb: context.i18n._("Dashboard") };
	},
	component: Dashboard,
});

/** Card tone: only warnings and errors color a card. */
function problemTone(items: { tone: StatusTone }[]): StatusTone {
	const tone = worstTone(items);
	return tone === "danger" || tone === "warning" ? tone : "neutral";
}

function Dashboard() {
	const { i18n } = useLingui();
	const can = useCan();
	const { data } = useQuery(dashboardQueryOptions);
	if (!data) return null;

	const readyServers = data.serversByStatus.ready ?? 0;
	// The optional local server only counts once it is in use.
	const usedServers = data.servers.filter(
		(server) => !isUnusedLocalServer(server),
	).length;
	const unreachable = unreachableServerIds(data.openAlerts);
	const health = new Map(
		data.serverHealth.map((item) => [item.serverId, item]),
	);
	const diskAlerts = data.openAlerts.filter(
		(alert) => alert.rule === "disk_usage",
	);
	const runningApps = data.appsByStatus.running ?? 0;
	const nonRunningApps = Math.max(0, data.appCount - runningApps);
	const appShare = (count: number) =>
		formatPercent(i18n.locale, data.appCount > 0 ? count / data.appCount : 0);
	const runningDatabases = data.databasesByStatus.running ?? 0;
	const notReadyServers = usedServers - readyServers;
	const appBreakdown = statusBreakdown(i18n, appStatuses, data.appsByStatus);
	const databaseBreakdown = statusBreakdown(
		i18n,
		appStatuses,
		data.databasesByStatus,
	);
	const domainBreakdown = statusBreakdown(
		i18n,
		domainCheckStatuses,
		data.domainsByCheck,
	);
	const jobBreakdown = statusBreakdown(i18n, deploymentStatuses, {
		running: data.jobsRunning,
		success: data.jobsSucceeded24h,
		failed: data.jobsFailed24h,
	});

	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Dashboard")}
				description={i18n._("Overview of your infrastructure")}
			/>
			<InstanceUpdateBanner />
			<OnboardingChecklist
				done={data.onboarding}
				installGuideUrl={data.installGuideUrl}
			/>
			<UpdatesCard />
			{diskAlerts.length > 0 && (
				<Alert
					color="red"
					variant="light"
					icon={<HardDrive size={18} />}
					title={i18n._("Disk usage above {percent}", {
						percent: formatPercentPoints(i18n.locale, data.diskAlertPercent),
					})}
				>
					<Group gap="xs">
						{diskAlerts.map((alert) => (
							<Anchor
								key={alert.id}
								component={LocalizedLink}
								to={`/servers/${alert.serverId}`}
								search={{ tab: "monitoring" }}
								size="sm"
								c="inherit"
								underline="always"
							>
								{i18n._("{server} {subject} ({percent})", {
									server: alert.serverName,
									subject: alert.subject,
									percent: formatPercentPoints(i18n.locale, alert.value),
								})}
							</Anchor>
						))}
					</Group>
				</Alert>
			)}
			<SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 5 }} spacing="md">
				<StatCard
					label={i18n._("Servers")}
					icon={Server}
					to="/servers"
					value={usedServers}
					tone={notReadyServers > 0 ? "warning" : "neutral"}
					breakdown={[
						...(readyServers > 0
							? [
									{
										key: "ready",
										tone: "success" as const,
										label: i18n._("{count} ready", { count: readyServers }),
									},
								]
							: []),
						...(notReadyServers > 0
							? [
									{
										key: "not-ready",
										tone: "warning" as const,
										label: i18n._("{count} not ready", {
											count: notReadyServers,
										}),
									},
								]
							: []),
					]}
					ratio={usedServers ? readyServers / usedServers : undefined}
					empty={{
						label: i18n._("No servers yet"),
						action: can("server.manage")
							? { label: i18n._("Add server"), to: "/servers" }
							: undefined,
					}}
				/>
				<StatCard
					label={i18n._("Apps")}
					icon={AppWindow}
					to="/apps"
					value={data.appCount}
					tone={problemTone(appBreakdown)}
					breakdown={appBreakdown}
					ratio={data.appCount ? runningApps / data.appCount : undefined}
					empty={{
						label: i18n._("No apps yet"),
						action: can("app.deploy")
							? { label: i18n._("Deploy app"), to: "/apps/new" }
							: undefined,
					}}
				/>
				<StatCard
					label={i18n._("Databases")}
					icon={Database}
					to="/databases"
					value={data.databaseCount}
					tone={problemTone(databaseBreakdown)}
					breakdown={databaseBreakdown}
					ratio={
						data.databaseCount
							? runningDatabases / data.databaseCount
							: undefined
					}
					empty={{
						label: i18n._("No databases yet"),
						action: can("database.manage")
							? { label: i18n._("Create database"), to: "/databases/new" }
							: undefined,
					}}
				/>
				<StatCard
					label={i18n._("Jobs (24h)")}
					icon={Activity}
					to="/jobs"
					search={data.jobsFailed24h > 0 ? { status: "failed" } : undefined}
					value={
						data.jobsFailed24h > 0 ? data.jobsFailed24h : data.jobsSucceeded24h
					}
					caption={
						data.jobsFailed24h > 0 ? i18n._("failed") : i18n._("succeeded")
					}
					tone={data.jobsFailed24h > 0 ? "danger" : "neutral"}
					breakdown={jobBreakdown}
				/>
				<StatCard
					label={i18n._("Domains")}
					icon={Globe}
					to="/domains"
					value={data.domainCount}
					tone={problemTone(domainBreakdown)}
					breakdown={domainBreakdown}
					empty={{ label: i18n._("No domains yet") }}
				/>
			</SimpleGrid>

			<SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
				<SectionCard
					title={i18n._("Server health")}
					actions={
						<Anchor component={LocalizedLink} to="/servers" size="sm">
							{i18n._("All servers")}
						</Anchor>
					}
					flush
				>
					{data.servers.length === 0 ? (
						<EmptyState
							compact
							icon={Server}
							title={i18n._("No servers yet")}
							description={i18n._(
								"Add your first VPS server to start deploying apps.",
							)}
						>
							{can("server.manage") && (
								<Button
									component={LocalizedLink}
									to="/servers"
									size="xs"
									leftSection={<Plus size={14} />}
								>
									{i18n._("Add server")}
								</Button>
							)}
						</EmptyState>
					) : (
						<Stack gap={0}>
							{data.servers.map((server) => (
								<Group
									key={server.id}
									justify="space-between"
									px="md"
									py="sm"
									style={{
										borderTop: "1px solid var(--mantine-color-default-border)",
									}}
									wrap="nowrap"
								>
									<Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
										<ServerLiveStatusBadge
											dot
											server={server}
											unreachable={unreachable}
										/>
										<Anchor
											component={LocalizedLink}
											to={`/servers/${server.id}`}
											fw={500}
											truncate
										>
											{server.name}
										</Anchor>
										<Text size="xs" c="dimmed" truncate visibleFrom="xs">
											{server.isDefault ? i18n._("Local host") : server.host}
										</Text>
									</Group>
									<Group gap="sm" wrap="nowrap">
										{health.get(server.id)?.ts && (
											<Text size="xs" c="dimmed" visibleFrom="sm">
												{i18n._("CPU {cpu} · RAM {mem} · Disk {disk}", {
													cpu: formatPercentPoints(
														i18n.locale,
														health.get(server.id)?.cpuPercent,
													),
													mem: formatPercentPoints(
														i18n.locale,
														health.get(server.id)?.memPercent,
													),
													disk: formatPercentPoints(
														i18n.locale,
														health.get(server.id)?.disk?.percent,
													),
												})}
											</Text>
										)}
										<ServerLiveStatusBadge
											server={server}
											unreachable={unreachable}
										/>
									</Group>
								</Group>
							))}
						</Stack>
					)}
				</SectionCard>

				<SectionCard
					title={i18n._("Apps by status")}
					actions={
						<Anchor component={LocalizedLink} to="/apps" size="sm">
							{i18n._("All apps")}
						</Anchor>
					}
				>
					{data.appCount === 0 ? (
						<EmptyState
							compact
							icon={AppWindow}
							title={i18n._("No apps yet")}
							description={i18n._("Pick a template to deploy your first app.")}
						>
							{can("app.deploy") && (
								<Button
									component={LocalizedLink}
									to="/apps/new"
									size="xs"
									leftSection={<Plus size={14} />}
								>
									{i18n._("Deploy your first app")}
								</Button>
							)}
						</EmptyState>
					) : (
						<Group
							gap="lg"
							align="center"
							wrap="wrap"
							justify="space-around"
							py="xs"
						>
							<RingProgress
								size={135}
								thickness={12}
								roundCaps
								sections={(() => {
									const sections = (
										Object.entries(data.appsByStatus) as [AppStatus, number][]
									)
										.filter(([, count]) => count > 0)
										.map(([status, count]) => {
											const meta = appStatuses[status];
											const value = (count / data.appCount) * 100;
											// An unknown status is shown as stored (data, not a message id).
											const label = meta ? i18n._(meta.label) : status;
											const color =
												status === "running"
													? "teal"
													: meta
														? toneColors[meta.tone]
														: "gray";
											return {
												value,
												color,
												tooltip: i18n._("{status}: {count} ({percent})", {
													status: label,
													count,
													percent: appShare(count),
												}),
											};
										});
									const classifiedCount = Object.values(
										data.appsByStatus,
									).reduce((sum, count) => sum + (count ?? 0), 0);
									const unclassified = Math.max(
										0,
										data.appCount - classifiedCount,
									);
									if (unclassified > 0) {
										sections.push({
											value: (unclassified / data.appCount) * 100,
											color: "gray.6",
											tooltip: i18n._("Other: {count}", {
												count: unclassified,
											}),
										});
									}
									return sections.length > 0
										? sections
										: [
												{
													value: 100,
													color: "gray.6",
													tooltip: i18n._("No status data"),
												},
											];
								})()}
								label={
									<Center>
										<Stack gap={0} align="center">
											<Text fw={700} size="xl" style={{ lineHeight: 1.1 }}>
												{appShare(runningApps)}
											</Text>
											<Text size="11px" c="dimmed" fw={500}>
												{i18n._("Running")}
											</Text>
										</Stack>
									</Center>
								}
							/>

							<Stack gap="xs" style={{ flex: 1, minWidth: 220 }}>
								<SimpleGrid cols={2} spacing="xs">
									<Box
										p="xs"
										style={{
											backgroundColor: "var(--mantine-color-default-hover)",
											borderRadius: "var(--mantine-radius-sm)",
											border: "1px solid var(--mantine-color-default-border)",
										}}
									>
										<Group gap={6} align="center">
											<Box
												w={7}
												h={7}
												bdrs="xl"
												bg="teal.6"
												style={{ flexShrink: 0 }}
											/>
											<Text size="xs" c="dimmed" fw={500}>
												{i18n._("Running")}
											</Text>
										</Group>
										<Group gap={4} align="baseline" mt={4}>
											<Text size="lg" fw={700} c="teal">
												{runningApps}
											</Text>
											<Text size="xs" c="dimmed">
												{i18n._("({percent})", {
													percent: appShare(runningApps),
												})}
											</Text>
										</Group>
									</Box>

									<Box
										p="xs"
										style={{
											backgroundColor: "var(--mantine-color-default-hover)",
											borderRadius: "var(--mantine-radius-sm)",
											border: "1px solid var(--mantine-color-default-border)",
										}}
									>
										<Group gap={6} align="center">
											<Box
												w={7}
												h={7}
												bdrs="xl"
												bg={nonRunningApps > 0 ? "orange.6" : "gray.6"}
												style={{ flexShrink: 0 }}
											/>
											<Text size="xs" c="dimmed" fw={500}>
												{i18n._("Not running")}
											</Text>
										</Group>
										<Group gap={4} align="baseline" mt={4}>
											<Text
												size="lg"
												fw={700}
												c={nonRunningApps > 0 ? "orange" : "dimmed"}
											>
												{nonRunningApps}
											</Text>
											<Text size="xs" c="dimmed">
												{i18n._("({percent})", {
													percent: appShare(nonRunningApps),
												})}
											</Text>
										</Group>
									</Box>
								</SimpleGrid>

								<Group gap="xs" wrap="wrap" mt={2}>
									{(Object.entries(data.appsByStatus) as [AppStatus, number][])
										.filter(([, count]) => count > 0)
										.map(([status, count]) => (
											<Badge
												key={status}
												size="sm"
												variant="light"
												color={
													status === "running"
														? "teal"
														: appStatuses[status]
															? toneColors[appStatuses[status].tone]
															: "gray"
												}
												leftSection={
													<StatusDot meta={appStatuses[status]} size={6} />
												}
											>
												{i18n._("{status}: {count}", {
													status: appStatuses[status]
														? i18n._(appStatuses[status].label)
														: status,
													count,
												})}
											</Badge>
										))}
								</Group>
							</Stack>
						</Group>
					)}
				</SectionCard>
			</SimpleGrid>

			<SectionCard
				title={i18n._("Open alerts")}
				description={i18n._(
					"Raised by monitoring; they resolve on their own when the condition clears.",
				)}
				flush
			>
				{data.openAlerts.length === 0 ? (
					<EmptyState
						compact
						icon={BellRing}
						title={i18n._("No open alerts")}
						description={i18n._("All monitored servers and apps look fine.")}
					/>
				) : (
					<AlertsList alerts={data.openAlerts} showTarget />
				)}
			</SectionCard>

			<SectionCard
				title={i18n._("Recent jobs")}
				actions={
					<Anchor component={LocalizedLink} to="/jobs" size="sm">
						{i18n._("All jobs")}
					</Anchor>
				}
				flush
			>
				<DataTable
					rows={data.recentJobs}
					getRowKey={(job) => job.id}
					empty={
						<Text size="sm" c="dimmed" p="md">
							{i18n._("No jobs yet.")}
						</Text>
					}
					columns={[
						{
							key: "job",
							header: i18n._("Job"),
							render: (job) => {
								const visual = getJobVisual(job.type);
								const Icon = visual.icon;
								return (
									<Group
										gap="sm"
										wrap="nowrap"
										align="center"
										style={{ minWidth: 0, overflow: "hidden" }}
									>
										<ThemeIcon
											variant="light"
											color={visual.color}
											size="md"
											radius="md"
											style={{ flexShrink: 0 }}
										>
											<Icon size={16} />
										</ThemeIcon>
										<Text size="sm" fw={500} truncate>
											{titleFor(i18n, job)}
										</Text>
									</Group>
								);
							},
						},
						{
							key: "target",
							header: i18n._("Target"),
							render: (job) => job.appName ?? job.serverName ?? "—",
						},
						{
							key: "status",
							header: i18n._("Status"),
							render: (job) => (
								<StatusBadge meta={deploymentStatuses[job.status]} />
							),
						},
						{
							key: "started",
							header: i18n._("Started"),
							hideOnMobile: true,
							render: (job) => <LocalDate value={job.createdAt} />,
						},
					]}
				/>
			</SectionCard>

			{data.domainIssues.length > 0 && (
				<SectionCard title={i18n._("Domains needing attention")} flush>
					<DataTable
						rows={data.domainIssues}
						getRowKey={(domain) => domain.id}
						columns={[
							{
								key: "host",
								header: i18n._("Host"),
								render: (domain) => {
									const checkStatuses = Object.values(domain.checks).map(
										(c) => c.status,
									);
									const color: MantineColor = checkStatuses.includes("error")
										? "red"
										: checkStatuses.includes("warning")
											? "yellow"
											: checkStatuses.length > 0 &&
													checkStatuses.every((s) => s === "ok")
												? "teal"
												: "blue";

									return (
										<Group
											gap="sm"
											wrap="nowrap"
											align="center"
											style={{ minWidth: 0, overflow: "hidden" }}
										>
											<ThemeIcon
												variant="light"
												color={color}
												size="md"
												radius="md"
												style={{ flexShrink: 0 }}
											>
												<Globe size={16} />
											</ThemeIcon>
											<Anchor
												component={LocalizedLink}
												to={`/apps/${domain.appId}`}
												search={{ tab: "domains" }}
												fw={500}
												size="sm"
												truncate
											>
												{domain.host}
											</Anchor>
										</Group>
									);
								},
							},
							{
								key: "app",
								header: i18n._("App"),
								render: (domain) => domain.appName,
							},
							{
								key: "checks",
								header: i18n._("Checks"),
								render: (domain) => (
									<Group gap={4}>
										{Object.entries(domain.checks).map(([id, check]) => (
											<StatusBadge
												key={id}
												meta={domainCheckStatuses[check.status]}
												title={storedCheckText(i18n, check)}
												fallback={id}
											/>
										))}
										<Text size="xs" c="dimmed">
											{Object.keys(domain.checks)
												.map((id) => domainCheckLabel(i18n, id))
												.join(" / ")}
										</Text>
									</Group>
								),
							},
						]}
					/>
				</SectionCard>
			)}
		</Stack>
	);
}
