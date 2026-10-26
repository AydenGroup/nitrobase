import { useLingui } from "@lingui/react";
import { Anchor, Card, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Cpu, DatabaseBackup, Globe } from "lucide-react";
import type { ReactNode } from "react";
import { DomainCheckBadge } from "#/components/dashboard/StatusBadge";
import { useCan } from "#/components/teams/useCan";
import { storedCheckText } from "#/config/check-details.ts";
import { domainCheckLabel } from "#/config/domain-checks.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import { appBackupSummaryQueryOptions } from "#/features/backups/backups.query.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatBytes, formatNumber, formatRelativeTime } from "#/libs/intl.ts";

const Tile: React.FC<{
	icon: ReactNode;
	title: string;
	children: ReactNode;
	tab: string;
	appId: string;
}> = ({ icon, title, children, tab, appId }) => (
	<Card withBorder p="sm">
		<Stack gap={6}>
			<Group gap={6} wrap="nowrap">
				{icon}
				<Anchor
					component={LocalizedLink}
					to={`/apps/${appId}`}
					search={{ tab } as never}
					size="sm"
					fw={600}
					c="inherit"
				>
					{title}
				</Anchor>
			</Group>
			{children}
		</Stack>
	</Card>
);

/** Domain/certificate, last backup and CPU/RAM at a glance (app overview). */
export const AppStatusStrip: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { i18n } = useLingui();
	const can = useCan();
	const { app } = overview;
	const summary = useQuery({
		...appBackupSummaryQueryOptions(app.id),
		enabled: can("backup.view"),
	});
	const primary = overview.domains.find((domain) => domain.primary);
	const checks = Object.entries(primary?.checks ?? {});
	const limits = overview.resources.reduce(
		(sum, item) => sum + (item.memoryMb ?? 0),
		0,
	);
	const last = summary.data?.lastBackup;

	return (
		<SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
			<Tile
				appId={app.id}
				tab="domains"
				icon={<Globe size={16} />}
				title={i18n._("Domain")}
			>
				<Text size="sm" truncate>
					{primary?.host ?? i18n._("No domain")}
				</Text>
				<Group gap={4}>
					{checks.length === 0 ? (
						<Text size="xs" c="dimmed">
							{i18n._("Not checked yet")}
						</Text>
					) : (
						checks.map(([id, check]) => (
							<DomainCheckBadge
								key={id}
								status={check.status}
								label={domainCheckLabel(i18n, id)}
								detail={storedCheckText(i18n, check)}
							/>
						))
					)}
				</Group>
			</Tile>
			<Tile
				appId={app.id}
				tab="backups"
				icon={<DatabaseBackup size={16} />}
				title={i18n._("Backups")}
			>
				{!can("backup.view") ? (
					<Text size="xs" c="dimmed">
						{i18n._("Not visible with your role.")}
					</Text>
				) : (
					<>
						<Text
							size="sm"
							c={
								!last ? "orange" : last.status === "success" ? undefined : "red"
							}
						>
							{!last
								? i18n._("Never backed up")
								: last.status === "success"
									? i18n._("Last backup {when}", {
											when: formatRelativeTime(i18n.locale, last.at),
										})
									: i18n._("Last backup failed {when}", {
											when: formatRelativeTime(i18n.locale, last.at),
										})}
						</Text>
						<Text size="xs" c="dimmed">
							{summary.data?.schedule?.enabled
								? i18n._("Scheduled ({cron})", {
										cron: summary.data.schedule.cron,
									})
								: i18n._("No schedule")}
						</Text>
					</>
				)}
			</Tile>
			<Tile
				appId={app.id}
				tab="monitoring"
				icon={<Cpu size={16} />}
				title={i18n._("Resources")}
			>
				{overview.usage ? (
					<Text size="sm">
						{i18n._("CPU {cpu}% · RAM {memory}", {
							cpu: formatNumber(i18n.locale, overview.usage.cpuPercent, {
								maximumFractionDigits: 1,
							}),
							memory: formatBytes(i18n.locale, overview.usage.memUsed),
						})}
					</Text>
				) : (
					<Text size="sm" c="dimmed">
						{i18n._("No recent samples")}
					</Text>
				)}
				<Text size="xs" c="dimmed">
					{limits > 0
						? i18n._("Memory limit {limit} in total", {
								limit: formatBytes(i18n.locale, limits * 1024 * 1024),
							})
						: i18n._("No resource limits")}
				</Text>
			</Tile>
		</SimpleGrid>
	);
};
