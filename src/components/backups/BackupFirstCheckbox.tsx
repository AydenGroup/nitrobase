import { useLingui } from "@lingui/react";
import { Anchor, Checkbox, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { appBackupSummaryQueryOptions } from "#/features/backups/backups.query.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatRelativeTime } from "#/libs/intl.ts";

/**
 * "Back up first" for risky actions. Offered whenever the team has a
 * destination (the schedule's, else the last backup's, else the first
 * one), with the app's last backup for context. Checked by default when
 * a destination exists.
 */
export const BackupFirstCheckbox: React.FC<{
	appId: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}> = ({ appId, checked, onChange }) => {
	const { i18n } = useLingui();
	const summary = useQuery(appBackupSummaryQueryOptions(appId));
	const data = summary.data;
	const destination = data?.destinations.find(
		(item) => item.id === data.defaultDestinationId,
	);
	const available = !!destination;
	useEffect(() => {
		if (summary.isFetched) onChange(available);
	}, [summary.isFetched, available, onChange]);
	if (!summary.isFetched || !data) return null;

	const last = data.lastBackup;
	const lastLine = last ? (
		<Text size="xs" c={last.status === "success" ? "dimmed" : "orange"}>
			{last.status === "success"
				? i18n._("Last backup: {when} on {destination}.", {
						when: formatRelativeTime(i18n.locale, last.at),
						destination: last.destinationName ?? "—",
					})
				: i18n._("The last backup failed ({when}).", {
						when: formatRelativeTime(i18n.locale, last.at),
					})}
		</Text>
	) : (
		<Text size="xs" c="orange">
			{i18n._("This app has never been backed up.")}
		</Text>
	);

	if (!available) {
		return (
			<Stack gap={2}>
				{lastLine}
				<Text size="xs" c="dimmed">
					{i18n._("No backup destination yet.")}{" "}
					<Anchor component={LocalizedLink} to="/destinations" size="xs">
						{i18n._("Add a destination")}
					</Anchor>
				</Text>
			</Stack>
		);
	}
	return (
		<Stack gap={4}>
			{lastLine}
			<Checkbox
				label={i18n._("Back up first (full backup to {destination})", {
					destination: destination.name,
				})}
				checked={checked}
				onChange={(event) => onChange(event.currentTarget.checked)}
			/>
		</Stack>
	);
};
