import { useLingui } from "@lingui/react";
import { ActionIcon, Anchor, Group, Text, Tooltip } from "@mantine/core";
import { RotateCw } from "lucide-react";
import { DataTable } from "#/components/ui/DataTable";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { lookup } from "#/config/labels.ts";
import {
	alertRuleMeta,
	containerHealthLabels,
	containerHealthTones,
} from "#/config/metrics.ts";
import type { LiveContainerSample } from "#/features/monitoring/schema.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import {
	formatBytes,
	formatPercent,
	formatPercentPoints,
	formatRate,
} from "#/libs/intl.ts";

/** Docker health when the container has a healthcheck, else its state. */
const ContainerHealthBadge: React.FC<{
	container: Pick<LiveContainerSample, "health" | "state">;
}> = ({ container }) => {
	const key = container.health ?? container.state ?? "";
	const tone = lookup(containerHealthTones, key);
	const label = lookup(containerHealthLabels, key);
	return (
		<StatusBadge
			meta={tone && label ? { label, tone } : undefined}
			fallback={key || "—"}
		/>
	);
};

/** Latest sample per container: health, restarts, CPU, memory, network. */
export const ContainersTable: React.FC<{
	containers: LiveContainerSample[];
	/** App id → name, to link containers to their app (server view). */
	appNames?: Map<string, string>;
	restartLoops?: Set<string>;
	loading?: boolean;
	/** Service → memory limit (bytes) Nitrobase set: usage shown against it. */
	memoryLimits?: Record<string, number>;
	/** App view only: restart one service (the server view passes nothing). */
	onRestart?: (service: string) => void;
	/** Which rows show the restart button, and whether it is greyed. */
	restartState?: (service: string | null | undefined) => {
		visible: boolean;
		disabled: boolean;
	};
}> = ({
	containers,
	appNames,
	restartLoops,
	loading,
	memoryLimits,
	onRestart,
	restartState,
}) => {
	const { i18n } = useLingui();
	return (
		<DataTable
			rows={containers}
			getRowKey={(row) => row.container}
			loading={loading}
			defaultSort={{ key: "name", direction: "asc" }}
			empty={
				<Text size="sm" c="dimmed" p="md">
					{i18n._("No containers reported yet.")}
				</Text>
			}
			columns={[
				{
					key: "name",
					header: i18n._("Container"),
					sortValue: (row) => row.container,
					render: (row) => (
						<Text size="sm" ff="monospace" truncate>
							{row.service ?? row.container}
						</Text>
					),
				},
				...(appNames
					? [
							{
								key: "app",
								header: i18n._("App"),
								sortValue: (row: LiveContainerSample) =>
									(row.appId && appNames.get(row.appId)) ?? "",
								render: (row: LiveContainerSample) =>
									row.appId ? (
										<Anchor
											component={LocalizedLink}
											to={`/apps/${row.appId}`}
											search={{ tab: "monitoring" }}
											size="sm"
										>
											{appNames.get(row.appId) ?? row.appId.slice(0, 8)}
										</Anchor>
									) : (
										<Text size="sm" c="dimmed">
											—
										</Text>
									),
							},
						]
					: []),
				{
					key: "health",
					header: i18n._("Health"),
					sortValue: (row) => row.health ?? row.state ?? "",
					render: (row) => (
						<Group gap={4} wrap="nowrap">
							<ContainerHealthBadge container={row} />
							{restartLoops?.has(row.container) && (
								<StatusBadge meta={alertRuleMeta.restart_loop} />
							)}
						</Group>
					),
				},
				{
					key: "restarts",
					header: i18n._("Restarts"),
					align: "right",
					sortValue: (row) => row.restartCount ?? 0,
					render: (row) => row.restartCount ?? "—",
				},
				{
					key: "cpu",
					header: i18n._("CPU"),
					align: "right",
					sortValue: (row) => row.cpuPercent ?? -1,
					render: (row) => formatPercentPoints(i18n.locale, row.cpuPercent),
				},
				{
					key: "memory",
					header: i18n._("Memory"),
					align: "right",
					sortValue: (row) => row.memUsed ?? -1,
					render: (row) => {
						const limit = row.service ? memoryLimits?.[row.service] : undefined;
						if (!limit || row.memUsed === null || row.memUsed === undefined) {
							return formatBytes(i18n.locale, row.memUsed);
						}
						const ratio = row.memUsed / limit;
						return (
							<Text
								size="sm"
								c={ratio >= 0.9 ? "red" : ratio >= 0.75 ? "yellow" : undefined}
								title={i18n._("Memory limit {limit}", {
									limit: formatBytes(i18n.locale, limit),
								})}
							>
								{i18n._("{used} of {limit} ({percent})", {
									used: formatBytes(i18n.locale, row.memUsed),
									limit: formatBytes(i18n.locale, limit),
									percent: formatPercent(i18n.locale, ratio, {
										maximumFractionDigits: 0,
									}),
								})}
							</Text>
						);
					},
				},
				{
					key: "network",
					header: i18n._("Network in / out"),
					align: "right",
					hideOnMobile: true,
					render: (row) =>
						`${formatRate(i18n.locale, row.netRxBps)} / ${formatRate(i18n.locale, row.netTxBps)}`,
				},
				...(onRestart
					? [
							{
								key: "actions",
								header: i18n._("Actions"),
								align: "right" as const,
								render: (row: LiveContainerSample) => {
									const service = row.service;
									const state = restartState?.(service) ?? {
										visible: !!service,
										disabled: false,
									};
									if (!service || !state.visible) return null;
									const label = i18n._("Restart {service}", { service });
									return (
										<Tooltip label={label}>
											<ActionIcon
												variant="subtle"
												color="gray"
												aria-label={label}
												disabled={state.disabled}
												onClick={() => onRestart(service)}
											>
												<RotateCw size={16} />
											</ActionIcon>
										</Tooltip>
									);
								},
							},
						]
					: []),
			]}
		/>
	);
};
