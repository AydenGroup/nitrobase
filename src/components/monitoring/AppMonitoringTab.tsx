import { useLingui } from "@lingui/react";
import {
	Alert,
	SegmentedControl,
	SimpleGrid,
	Stack,
	Text,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { useState } from "react";
import { AppJobDrawer } from "#/components/apps/AppJobDrawer";
import { useAppJob } from "#/components/apps/useAppJob";
import { useCan } from "#/components/teams/useCan";
import { EmptyState } from "#/components/ui/EmptyState";
import { SectionCard } from "#/components/ui/SectionCard";
import { lookup } from "#/config/labels.ts";
import { alertRuleMeta, metricRanges, rangeSeconds } from "#/config/metrics.ts";
import { appStatuses, isBusy } from "#/config/status.ts";
import { appActionFn } from "#/features/apps/apps.functions.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import { serviceRestartState } from "#/features/apps/service-restart.ts";
import {
	alertsQueryOptions,
	appHistoryQueryOptions,
} from "#/features/monitoring/monitoring.query.ts";
import type {
	ContainerHistoryPoint,
	MetricRange,
} from "#/features/monitoring/schema.ts";
import { formatBytes, formatPercentPoints, formatRate } from "#/libs/intl.ts";
import { AlertsList } from "./AlertsList";
import { ContainersTable } from "./ContainersTable";
import { MetricChart, pivotSeries } from "./MetricChart";
import { useMonitoringStream } from "./useMonitoringStream";

const serviceOf = (row: ContainerHistoryPoint) => row.service ?? row.container;

/** Per-service charts, health and alerts of one app. */
export const AppMonitoringTab: React.FC<{
	overview: AppOverview;
	/** The app page only: restart one service from the table. */
	serviceRestart?: boolean;
}> = ({ overview, serviceRestart = false }) => {
	const { i18n } = useLingui();
	const { app } = overview;
	const can = useCan();
	const jobs = useAppJob(app.id);
	const busy = jobs.isStarting || isBusy(appStatuses, app.status);
	const restartState = (service: string | null | undefined) =>
		serviceRestartState({
			service,
			permitted: can("app.deploy"),
			deployed: overview.services.length > 0,
			appStatus: app.status,
			busy,
		});
	const confirmRestart = (service: string) =>
		modals.openConfirmModal({
			title: i18n._("Restart {service}", { service }),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._(
						"{service} restarts now and is unavailable for a few seconds. The other services keep running.",
						{ service },
					)}
				</Text>
			),
			labels: { confirm: i18n._("Restart"), cancel: i18n._("Cancel") },
			onConfirm: () =>
				jobs.startJob({
					title: i18n._("Restart {service}", { service }),
					start: () =>
						appActionFn({
							data: { appId: app.id, action: "restart", service },
						}),
				}),
		});
	const [range, setRange] = useState<MetricRange>("1h");
	const live = useMonitoringStream(
		`/api/apps/${encodeURIComponent(app.id)}/metrics`,
	);
	const history = useQuery(appHistoryQueryOptions(app.id, range));
	const alerts = useQuery(alertsQueryOptions({ appId: app.id }));
	const containers =
		[...live.ticks].reverse().find((tick) => tick.containers)?.containers ?? [];
	const restartLoops = new Set(
		(alerts.data ?? [])
			.filter((alert) => alert.rule === "restart_loop")
			.map((alert) => alert.subject),
	);
	const rows = history.data?.points ?? [];
	const seconds = rangeSeconds(range);
	const pivot = (value: (row: ContainerHistoryPoint) => number | null) =>
		pivotSeries(rows, {
			time: (row) => row.t,
			key: serviceOf,
			value,
			otherLabel: i18n._("Other"),
		});
	const charts = [
		{
			title: i18n._("CPU by service"),
			series: pivot((row) => row.cpuPercent),
			format: (value: number) => formatPercentPoints(i18n.locale, value),
		},
		{
			title: i18n._("Memory by service"),
			series: pivot((row) => row.memUsed),
			format: (value: number) => formatBytes(i18n.locale, value),
		},
		{
			title: i18n._("Network in by service"),
			series: pivot((row) => row.netRxBps),
			format: (value: number) => formatRate(i18n.locale, value),
		},
		{
			title: i18n._("Network out by service"),
			series: pivot((row) => row.netTxBps),
			format: (value: number) => formatRate(i18n.locale, value),
		},
	];

	if (overview.services.length === 0) {
		return (
			<SectionCard>
				<EmptyState
					compact
					icon={Gauge}
					title={i18n._("Monitoring")}
					description={i18n._("Available after the first deploy.")}
				/>
			</SectionCard>
		);
	}

	const lastTick = live.ticks.at(-1);
	return (
		<Stack gap="md">
			{lastTick && !lastTick.ok && (
				<Alert color="red" variant="light">
					{i18n._("{problem} · Showing the last known data.", {
						problem: i18n._(
							lookup(alertRuleMeta, lastTick.problem)?.label ??
								alertRuleMeta.server_unreachable.label,
						),
					})}
				</Alert>
			)}
			{(alerts.data ?? []).length > 0 && (
				<SectionCard title={i18n._("Open alerts")} flush>
					<AlertsList alerts={alerts.data ?? []} />
				</SectionCard>
			)}
			<SectionCard
				title={i18n._("Services")}
				description={i18n._("Live health and usage of the app's containers.")}
				flush
			>
				<ContainersTable
					memoryLimits={Object.fromEntries(
						overview.resources
							.filter((item) => item.memoryMb)
							.map((item) => [
								item.service,
								(item.memoryMb as number) * 1024 * 1024,
							]),
					)}
					containers={containers}
					restartLoops={restartLoops}
					onRestart={serviceRestart ? confirmRestart : undefined}
					restartState={restartState}
					loading={live.connection === "connecting"}
				/>
			</SectionCard>
			<SectionCard
				title={i18n._("History")}
				actions={
					<SegmentedControl
						size="xs"
						value={range}
						onChange={(value) => setRange(value as MetricRange)}
						data={metricRanges.map((item) => ({
							value: item.id,
							label: i18n._(item.label),
						}))}
					/>
				}
			>
				{rows.length === 0 && !history.isLoading ? (
					<Text size="sm" c="dimmed">
						{i18n._("No data for this range yet.")}
					</Text>
				) : (
					<SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
						{charts.map((chart) => (
							<MetricChart
								key={chart.title}
								title={chart.title}
								data={chart.series.data}
								series={chart.series.series}
								format={chart.format}
								rangeSeconds={seconds}
							/>
						))}
					</SimpleGrid>
				)}
			</SectionCard>
			<AppJobDrawer
				job={jobs.job}
				appName={app.name}
				onClose={jobs.closeJob}
				onCompleted={jobs.refresh}
			/>
		</Stack>
	);
};
