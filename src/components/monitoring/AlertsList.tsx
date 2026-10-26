import { useLingui } from "@lingui/react";
import { Anchor, Group, Stack, Text } from "@mantine/core";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { lookup } from "#/config/labels.ts";
import { alertRuleMeta } from "#/config/metrics.ts";
import type { AlertDTO } from "#/features/monitoring/schema.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatDate, formatNumber } from "#/libs/intl.ts";

/** Rule label as a status badge (unknown rules show their id). */
const AlertRuleBadge: React.FC<{ rule: string }> = ({ rule }) => {
	const meta = lookup(alertRuleMeta, rule);
	return (
		<StatusBadge
			meta={meta ? { label: meta.label, tone: meta.tone } : undefined}
			fallback={rule}
		/>
	);
};

/** One line describing an alert (subject, value, threshold). */
function useAlertText() {
	const { i18n } = useLingui();
	return (alert: AlertDTO) => {
		const meta = lookup(alertRuleMeta, alert.rule);
		const params = {
			subject: alert.subject,
			value: formatNumber(i18n.locale, alert.value, {
				maximumFractionDigits: 1,
			}),
			threshold: formatNumber(i18n.locale, alert.threshold),
		};
		return meta ? i18n._({ ...meta.describe, values: params }) : alert.subject;
	};
}

/** Compact alert rows (dashboard, monitoring tabs). */
export const AlertsList: React.FC<{
	alerts: AlertDTO[];
	/** Show the server/app the alert belongs to. */
	showTarget?: boolean;
}> = ({ alerts, showTarget = false }) => {
	const { i18n } = useLingui();
	const describe = useAlertText();
	return (
		<Stack gap={0}>
			{alerts.map((alert) => (
				<Group
					key={alert.id}
					justify="space-between"
					px="md"
					py="sm"
					wrap="nowrap"
					style={{
						borderTop: "1px solid var(--mantine-color-default-border)",
					}}
				>
					<Stack gap={2} style={{ minWidth: 0 }}>
						<Group gap="xs" wrap="nowrap">
							<AlertRuleBadge rule={alert.rule} />
							{showTarget && (
								<Anchor
									component={LocalizedLink}
									to={
										alert.appId
											? `/apps/${alert.appId}`
											: `/servers/${alert.serverId}`
									}
									search={{ tab: "monitoring" }}
									size="sm"
									truncate
								>
									{alert.appName ?? alert.serverName}
								</Anchor>
							)}
						</Group>
						<Text size="sm" c="dimmed" truncate>
							{describe(alert)}
						</Text>
					</Stack>
					<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
						{alert.status === "open"
							? i18n._("since {time}", {
									time: formatDate(i18n.locale, alert.openedAt),
								})
							: i18n._("resolved {time}", {
									time: formatDate(
										i18n.locale,
										alert.resolvedAt ?? alert.lastSeenAt,
									),
								})}
					</Text>
				</Group>
			))}
		</Stack>
	);
};

/** Restart-loop / unhealthy indicators next to an app's status. */
export const AppHealthBadges: React.FC<{
	appId: string;
	alerts: AlertDTO[] | undefined;
}> = ({ appId, alerts }) => {
	const describe = useAlertText();
	const own = (alerts ?? []).filter(
		(alert) => alert.appId === appId && alert.status === "open",
	);
	const rules = [...new Set(own.map((alert) => alert.rule))];
	if (rules.length === 0) return null;
	return (
		<Group gap={4} wrap="nowrap">
			{rules.map((rule) => {
				const meta = lookup(alertRuleMeta, rule);
				return (
					<StatusBadge
						key={rule}
						meta={meta ? { label: meta.label, tone: meta.tone } : undefined}
						fallback={rule}
						title={own
							.filter((alert) => alert.rule === rule)
							.map(describe)
							.join("\n")}
					/>
				);
			})}
		</Group>
	);
};
