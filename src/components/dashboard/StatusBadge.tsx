import { useLingui } from "@lingui/react";
import { Badge, Group } from "@mantine/core";
import { StatusBadge } from "#/components/ui/StatusBadge";
import {
	appDisplayStatus,
	appStatuses,
	deploymentStatuses,
	domainCheckStatuses,
} from "#/config/status.ts";
import type { AppStatus, DomainCheckStatus } from "#/features/apps/schema.ts";
import type { DeploymentStatus } from "#/features/servers/schema.ts";
import { formatList } from "#/libs/intl.ts";
import { toneColors } from "#/theme/tokens.ts";

export const DeploymentStatusBadge: React.FC<{
	status: DeploymentStatus;
	/** Problems the job tolerated (e.g. SQL errors of a restore). */
	warningCount?: number;
}> = ({ status, warningCount = 0 }) => {
	const { i18n } = useLingui();
	return (
		<Group gap={4} wrap="nowrap">
			<StatusBadge meta={deploymentStatuses[status]} fallback={status} />
			{warningCount > 0 && (
				<Badge color={toneColors.warning} variant="light" size="sm">
					{i18n._("{count} warnings", { count: warningCount })}
				</Badge>
			)}
		</Group>
	);
};

export const AppStatusBadge: React.FC<{
	status: AppStatus;
	/** Long-running services without a running container (monitoring). */
	notRunning?: readonly string[];
}> = ({ status, notRunning = [] }) => {
	const { i18n } = useLingui();
	const meta = appDisplayStatus(status, notRunning);
	return (
		<StatusBadge
			meta={meta}
			fallback={status}
			title={
				meta === appStatuses[status]
					? undefined
					: i18n._("Not running: {services}", {
							services: formatList(i18n.locale, notRunning, "unit"),
						})
			}
		/>
	);
};

export const DomainCheckBadge: React.FC<{
	status: DomainCheckStatus;
	label: string;
	detail?: string | null;
}> = ({ status, label, detail }) => {
	const { i18n } = useLingui();
	const meta = domainCheckStatuses[status];
	return (
		<Badge
			color={meta ? toneColors[meta.tone] : "gray"}
			variant="light"
			size="sm"
			title={detail ?? undefined}
		>
			{label}: {meta ? i18n._(meta.label) : status}
		</Badge>
	);
};
