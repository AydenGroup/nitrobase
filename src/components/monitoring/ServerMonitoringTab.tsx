import { useLingui } from "@lingui/react";
import { Sparkline } from "@mantine/charts";
import {
	Badge,
	Card,
	Group,
	Progress,
	SegmentedControl,
	SimpleGrid,
	Stack,
	Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, Clock, Cpu, Gauge, Layers } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "#/components/ui/EmptyState";
import { ErrorText } from "#/components/ui/ErrorText.tsx";
import { SectionCard } from "#/components/ui/SectionCard";
import { StatusBadge } from "#/components/ui/StatusBadge";
import {
	metricRanges,
	monitorStatusMeta,
	rangeSeconds,
} from "#/config/metrics.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import {
	alertsQueryOptions,
	serverHistoryQueryOptions,
} from "#/features/monitoring/monitoring.query.ts";
import type {
	LiveServerSample,
	MetricRange,
} from "#/features/monitoring/schema.ts";
import {
	formatBytes,
	formatDate,
	formatNumber,
	formatPercentPoints,
	formatRate,
	formatUptime,
} from "#/libs/intl.ts";
import { chartSeriesColors } from "#/theme/tokens.ts";
import { AlertsList } from "./AlertsList";
import { ContainersTable } from "./ContainersTable";
import { MetricChart, pivotSeries } from "./MetricChart";
import { useMonitoringStream } from "./useMonitoringStream";

const memPercent = (sample: LiveServerSample) =>
	sample.memUsed !== null && sample.memTotal
		? (sample.memUsed / sample.memTotal) * 100
		: null;

const diskUsage = (disk: { used: number; avail: number }) =>
	disk.used + disk.avail > 0 ? (disk.used / (disk.used + disk.avail)) * 100 : 0;

function renderMetricValue(val: string) {
	const lastSpace = val.lastIndexOf(" ");
	if (lastSpace > 0 && lastSpace < val.length - 1) {
		const unitCandidate = val.slice(lastSpace + 1);
		if (unitCandidate.endsWith("/s") || unitCandidate.includes("B/s")) {
			const numberPart = val.slice(0, lastSpace);
			return (
				<Text
					size="xl"
					fw={700}
					style={{ whiteSpace: "nowrap", lineHeight: 1.2 }}
				>
					{numberPart}{" "}
					<Text span size="xs" fw={500} c="dimmed">
						{unitCandidate}
					</Text>
				</Text>
			);
		}
	}
	return (
		<Text size="xl" fw={700} style={{ whiteSpace: "nowrap", lineHeight: 1.2 }}>
			{val}
		</Text>
	);
}

/** Small live tile: current value + sparkline of the live window. */
const LiveTile: React.FC<{
	label: string;
	value: string;
	detail?: React.ReactNode;
	points?: number[];
	color?: string;
	icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
	badge?: React.ReactNode;
}> = ({
	label,
	value,
	detail,
	points = [],
	color = chartSeriesColors[0],
	icon: Icon,
	badge,
}) => (
	<Card
		withBorder
		p="md"
		style={{
			display: "flex",
			flexDirection: "column",
			justifyContent: "space-between",
			minHeight: 120,
		}}
	>
		<div>
			<Group justify="space-between" align="center" mb={8} wrap="nowrap">
				<Text size="sm" c="dimmed" fw={500}>
					{label}
				</Text>
				<Icon size={16} style={{ opacity: 0.5, flexShrink: 0 }} />
			</Group>
			<Group justify="space-between" align="flex-end" wrap="nowrap" gap="xs">
				<div style={{ minWidth: 0, flex: 1 }}>{renderMetricValue(value)}</div>
				{points.length > 1 ? (
					<Sparkline
						w={80}
						h={30}
						data={points}
						color={color}
						curveType="linear"
						fillOpacity={0.2}
						strokeWidth={1.5}
						style={{ flexShrink: 0 }}
					/>
				) : badge ? (
					<div style={{ flexShrink: 0 }}>{badge}</div>
				) : null}
			</Group>
		</div>
		{detail && (
			<Text
				size="xs"
				c="dimmed"
				mt={10}
				truncate
				title={typeof detail === "string" ? detail : undefined}
			>
				{detail}
			</Text>
		)}
	</Card>
);

export const ServerMonitoringTab: React.FC<{
	serverId: string;
	ready: boolean;
}> = ({ serverId, ready }) => {
	const { i18n } = useLingui();
	const [range, setRange] = useState<MetricRange>("1h");
	const live = useMonitoringStream(
		`/api/servers/${encodeURIComponent(serverId)}/metrics`,
	);
	const history = useQuery(serverHistoryQueryOptions(serverId, range));
	const alerts = useQuery(alertsQueryOptions({ serverId }));
	const apps = useQuery(appsQueryOptions);
	const appNames = useMemo(
		() => new Map((apps.data ?? []).map((app) => [app.id, app.name])),
		[apps.data],
	);

	const samples = live.ticks
		.map((tick) => tick.server)
		.filter((sample): sample is LiveServerSample => sample !== null);
	const latest = samples.at(-1) ?? null;
	const lastTick = live.ticks.at(-1);
	const containers =
		[...live.ticks].reverse().find((tick) => tick.containers)?.containers ?? [];
	const restartLoops = new Set(
		(alerts.data ?? [])
			.filter((alert) => alert.rule === "restart_loop")
			.map((alert) => alert.subject),
	);
	const seconds = rangeSeconds(range);
	const thresholds = live.thresholds;

	const points = history.data?.points ?? [];
	const memory = points.map((point) => ({
		t: point.t,
		used:
			point.memUsed !== null && point.memTotal
				? (point.memUsed / point.memTotal) * 100
				: null,
	}));
	const disks = pivotSeries(history.data?.disks ?? [], {
		time: (row) => row.t,
		key: (row) => row.mount,
		value: (row) => row.percent,
		otherLabel: i18n._("Other"),
	});

	if (!ready && live.ticks.length === 0 && points.length === 0) {
		return (
			<SectionCard>
				<EmptyState
					compact
					icon={Gauge}
					title={i18n._("Monitoring")}
					description={i18n._(
						"Metrics are collected once the server is Ready (bootstrapped).",
					)}
				/>
			</SectionCard>
		);
	}

	return (
		<Stack gap="md">
			<Group justify="space-between">
				<Group gap="xs">
					<StatusBadge meta={monitorStatusMeta[live.status]} />
					{lastTick && (
						<Text size="xs" c="dimmed">
							{i18n._("Updated {time}", {
								time: formatDate(i18n.locale, lastTick.ts, {
									timeStyle: "medium",
								}),
							})}
						</Text>
					)}
				</Group>
				{lastTick && !lastTick.ok && lastTick.error && (
					<ErrorText
						size="xs"
						c="red"
						lineClamp={1}
						maw={480}
						error={lastTick.error}
					/>
				)}
			</Group>

			<SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} spacing="md">
				<LiveTile
					label={i18n._("CPU")}
					icon={Cpu}
					value={formatPercentPoints(i18n.locale, latest?.cpuPercent)}
					detail={i18n._("Load {load}", {
						load: latest
							? [latest.load1, latest.load5, latest.load15]
									.map((value) =>
										formatNumber(i18n.locale, value, {
											minimumFractionDigits: 2,
											maximumFractionDigits: 2,
										}),
									)
									.join(" / ")
							: "—",
					})}
					points={samples
						.map((sample) => sample.cpuPercent)
						.filter((value): value is number => value !== null)}
					color={chartSeriesColors[0]}
				/>
				<LiveTile
					label={i18n._("Memory")}
					icon={Layers}
					value={formatPercentPoints(
						i18n.locale,
						latest ? memPercent(latest) : null,
					)}
					detail={
						latest
							? `${formatBytes(i18n.locale, latest.memUsed)} / ${formatBytes(i18n.locale, latest.memTotal)}${
									latest.swapTotal
										? ` · ${i18n._("swap {used}", { used: formatBytes(i18n.locale, latest.swapUsed) })}`
										: ""
								}`
							: undefined
					}
					points={samples
						.map(memPercent)
						.filter((value): value is number => value !== null)}
					color={chartSeriesColors[1]}
				/>
				<LiveTile
					label={i18n._("Network in")}
					icon={ArrowUpDown}
					value={formatRate(i18n.locale, latest?.netRxBps)}
					detail={i18n._("Out {rate}", {
						rate: formatRate(i18n.locale, latest?.netTxBps),
					})}
					points={samples
						.map((sample) => sample.netRxBps)
						.filter((value): value is number => value !== null)}
					color={chartSeriesColors[2]}
				/>
				<LiveTile
					label={i18n._("Uptime")}
					icon={Clock}
					value={formatUptime(i18n.locale, latest?.uptimeSeconds)}
					badge={
						<Badge size="xs" variant="light" color="teal">
							{i18n._("Online")}
						</Badge>
					}
					detail={
						latest?.uptimeSeconds != null && latest?.ts != null
							? i18n._("Since {time}", {
									time: formatDate(
										i18n.locale,
										new Date(latest.ts - latest.uptimeSeconds * 1000),
										{ dateStyle: "short", timeStyle: "short" },
									),
								})
							: undefined
					}
				/>
			</SimpleGrid>

			{latest && latest.disks.length > 0 && (
				<SectionCard title={i18n._("Disks")}>
					<Stack gap="sm">
						{latest.disks.map((disk) => {
							const percent = diskUsage(disk);
							const over =
								thresholds !== null && percent > thresholds.diskPercent;
							return (
								<Stack key={disk.mount} gap={4}>
									<Group justify="space-between" wrap="nowrap">
										<Text size="sm" ff="monospace" truncate>
											{disk.mount}
										</Text>
										<Text size="sm" c={over ? "red" : undefined}>
											{formatPercentPoints(i18n.locale, percent)} ·{" "}
											{i18n._("{used} of {total}", {
												used: formatBytes(i18n.locale, disk.used),
												total: formatBytes(i18n.locale, disk.total),
											})}
										</Text>
									</Group>
									<Progress
										value={percent}
										color={over ? "red" : "brand"}
										aria-label={disk.mount}
									/>
								</Stack>
							);
						})}
					</Stack>
				</SectionCard>
			)}

			{(alerts.data ?? []).length > 0 && (
				<SectionCard title={i18n._("Open alerts")} flush>
					<AlertsList alerts={alerts.data ?? []} showTarget />
				</SectionCard>
			)}

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
				<SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
					<MetricChart
						title={i18n._("CPU")}
						data={points.map((point) => ({
							t: point.t,
							cpu: point.cpuPercent,
						}))}
						series={[{ name: "cpu", label: i18n._("CPU") }]}
						format={(value) => formatPercentPoints(i18n.locale, value)}
						rangeSeconds={seconds}
						yMax={100}
						area
					/>
					<MetricChart
						title={i18n._("Memory")}
						data={memory}
						series={[{ name: "used", label: i18n._("Memory") }]}
						format={(value) => formatPercentPoints(i18n.locale, value)}
						rangeSeconds={seconds}
						yMax={100}
						area
						reference={
							thresholds
								? {
										y: thresholds.memoryPercent,
										label: i18n._("Alert"),
									}
								: undefined
						}
					/>
					<MetricChart
						title={i18n._("Disk usage")}
						data={disks.data}
						series={disks.series}
						format={(value) => formatPercentPoints(i18n.locale, value)}
						rangeSeconds={seconds}
						yMax={100}
						reference={
							thresholds
								? { y: thresholds.diskPercent, label: i18n._("Alert") }
								: undefined
						}
					/>
					<MetricChart
						title={i18n._("Network")}
						data={points.map((point) => ({
							t: point.t,
							rx: point.netRxBps,
							tx: point.netTxBps,
						}))}
						series={[
							{ name: "rx", label: i18n._("In") },
							{ name: "tx", label: i18n._("Out") },
						]}
						format={(value) => formatRate(i18n.locale, value)}
						rangeSeconds={seconds}
					/>
					<MetricChart
						title={i18n._("Load average")}
						data={points.map((point) => ({
							t: point.t,
							load1: point.load1,
							load5: point.load5,
							load15: point.load15,
						}))}
						series={[
							{ name: "load1", label: i18n._("1 min") },
							{ name: "load5", label: i18n._("5 min") },
							{ name: "load15", label: i18n._("15 min") },
						]}
						format={(value) =>
							formatNumber(i18n.locale, value, {
								minimumFractionDigits: 2,
								maximumFractionDigits: 2,
							})
						}
						rangeSeconds={seconds}
					/>
				</SimpleGrid>
			</SectionCard>

			<SectionCard
				title={i18n._("Containers")}
				description={i18n._("Latest sample of every container on the server.")}
				flush
			>
				<ContainersTable
					containers={containers}
					appNames={appNames}
					restartLoops={restartLoops}
					loading={live.connection === "connecting"}
				/>
			</SectionCard>
		</Stack>
	);
};
