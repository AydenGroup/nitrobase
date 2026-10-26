import { useLingui } from "@lingui/react";
import {
	Button,
	Group,
	NumberInput,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { destinationCapabilities } from "#/config/backup-drivers.ts";
import { APP_NAME, BACKUP_POLICY, MAX_DAYS } from "#/config/shared.ts";
import { schedulerClockQueryOptions } from "#/features/backups/backups.query.ts";
import type { DestinationDTO, PolicyDTO } from "#/features/backups/schema.ts";
import {
	buildSchedule,
	nextRunAt,
	parseSchedule,
	type SchedulePreset,
} from "#/libs/cron.ts";
import { formatDate, formatUtcOffset } from "#/libs/intl.ts";

export interface PolicyValues {
	destinationId: string;
	cron: string;
	keepLast: number | null;
	keepDays: number | null;
	includeManual?: boolean;
	enabled: boolean;
}

/** Schedule + retention form shared by app policies and the self-backup. */
export const PolicyEditor: React.FC<{
	policy: PolicyDTO | null;
	destinations: DestinationDTO[];
	saving: boolean;
	error?: string;
	onSave: (values: PolicyValues) => void;
	onChange?: () => void;
	/** Extra fields (e.g. the self-backup's server). */
	children?: ReactNode;
	extraValid?: boolean;
	/** Offer "also prune manual backups" (app policies). */
	manualRetention?: boolean;
}> = ({
	policy,
	destinations,
	saving,
	error,
	onSave,
	onChange,
	children,
	extraValid = true,
	manualRetention = false,
}) => {
	const { i18n } = useLingui();
	const initial = parseSchedule(policy?.cron ?? BACKUP_POLICY.defaultCron);
	const [destinationId, setDestinationId] = useState<string | null>(
		policy?.destinationId ?? destinations[0]?.id ?? null,
	);
	const [preset, setPreset] = useState<SchedulePreset>(initial.preset);
	const [hour, setHour] = useState(initial.hour);
	const [weekday, setWeekday] = useState(initial.weekday);
	const [custom, setCustom] = useState(
		policy?.cron ?? BACKUP_POLICY.defaultCron,
	);
	const [keepLast, setKeepLast] = useState<number | null>(
		policy?.keepLast ?? BACKUP_POLICY.defaultKeepLast,
	);
	const [keepDays, setKeepDays] = useState<number | null>(
		policy?.keepDays ?? null,
	);
	const [enabled, setEnabled] = useState(policy?.enabled ?? true);
	const [includeManual, setIncludeManual] = useState(
		policy?.includeManual ?? false,
	);
	useEffect(() => {
		if (!destinationId && destinations[0]) setDestinationId(destinations[0].id);
	}, [destinations, destinationId]);
	const changed =
		<T,>(set: (value: T) => void) =>
		(value: T) => {
			onChange?.();
			set(value);
		};
	const clock = useQuery(schedulerClockQueryOptions);
	// Next run in the scheduler's zone, shown in the viewer's.
	const cron = buildSchedule({ preset, hour, weekday }, custom);
	const nextRun = nextRunAt(cron, { timezone: clock.data?.timeZone });
	const weekdays = Array.from({ length: 7 }, (_, day) => ({
		value: String(day),
		// 2023-01-01 was a Sunday (cron day 0).
		label: formatDate(i18n.locale, new Date(Date.UTC(2023, 0, 1 + day)), {
			weekday: "long",
			timeZone: "UTC",
		}),
	}));
	const hours = Array.from({ length: 24 }, (_, value) => ({
		value: String(value),
		label: `${String(value).padStart(2, "0")}:00`,
	}));

	return (
		<Stack gap="sm">
			<Select
				label={i18n._("Destination")}
				data={destinations.map((item) => ({
					value: item.id,
					label: item.name,
				}))}
				value={destinationId}
				onChange={changed(setDestinationId)}
				allowDeselect={false}
				placeholder={i18n._("Add a destination first")}
			/>
			{destinationCapabilities(
				destinations.find((item) => item.id === destinationId)?.type ?? "",
			).onServer && (
				<Text size="xs" c="yellow">
					{i18n._(
						"This destination is a folder on the app's own server: not an off-site copy, it is lost with the server.",
					)}
				</Text>
			)}
			{children}
			<Stack gap={4}>
				<Text size="sm" fw={500}>
					{i18n._("Schedule")}
				</Text>
				<SegmentedControl
					value={preset}
					onChange={(value) => changed(setPreset)(value as SchedulePreset)}
					data={[
						{ value: "daily", label: i18n._("Daily") },
						{ value: "weekly", label: i18n._("Weekly") },
						{ value: "custom", label: i18n._("Custom (cron)") },
					]}
				/>
			</Stack>
			<Group grow>
				{preset === "weekly" && (
					<Select
						label={i18n._("Day")}
						data={weekdays}
						value={String(weekday)}
						onChange={(value) => value && changed(setWeekday)(Number(value))}
						allowDeselect={false}
					/>
				)}
				{preset !== "custom" ? (
					<Select
						label={
							clock.data
								? i18n._("Time ({zone}, {offset})", {
										zone: clock.data.timeZone,
										offset: formatUtcOffset(clock.data.offsetMinutes),
									})
								: i18n._("Time")
						}
						description={i18n._("The time zone of the {appName} server", {
							appName: APP_NAME,
						})}
						data={hours}
						value={String(hour)}
						onChange={(value) => value && changed(setHour)(Number(value))}
						allowDeselect={false}
					/>
				) : (
					<TextInput
						label={i18n._("Cron expression")}
						description={i18n._(
							"minute hour day month weekday, e.g. 30 2 * * 1-5",
						)}
						value={custom}
						onChange={(event) => changed(setCustom)(event.currentTarget.value)}
						ff="monospace"
					/>
				)}
			</Group>
			{enabled && (
				<Text size="xs" c="dimmed">
					{nextRun
						? i18n._("Next run: {date}", {
								date: formatDate(i18n.locale, nextRun, {
									dateStyle: "full",
									timeStyle: "short",
								}),
							})
						: preset === "custom"
							? i18n._("Not a valid cron expression yet.")
							: null}
				</Text>
			)}
			<Group grow align="flex-start">
				<NumberInput
					label={i18n._("Keep the last")}
					description={i18n._("backups (empty: no count limit)")}
					value={keepLast ?? ""}
					onChange={(value) =>
						changed(setKeepLast)(typeof value === "number" ? value : null)
					}
					min={1}
					max={BACKUP_POLICY.maxKeepLast}
				/>
				<NumberInput
					label={i18n._("Keep for")}
					description={i18n._("days (empty: no age limit)")}
					value={keepDays ?? ""}
					onChange={(value) =>
						changed(setKeepDays)(typeof value === "number" ? value : null)
					}
					min={1}
					max={MAX_DAYS}
				/>
			</Group>
			<Text size="xs" c="dimmed">
				{i18n._(
					"A backup is kept when it matches either rule; the newest one is always kept. Without rules, nothing is deleted.",
				)}{" "}
				{manualRetention && !includeManual
					? i18n._(
							"Rules apply to scheduled backups only: manual backups are kept until you delete them.",
						)
					: null}
			</Text>
			{manualRetention && (
				<Switch
					label={i18n._("Also apply retention to manual backups")}
					description={i18n._(
						"Counts this app's manual backups on the same destination toward the rules above (they can then be deleted).",
					)}
					checked={includeManual}
					onChange={(event) =>
						changed(setIncludeManual)(event.currentTarget.checked)
					}
				/>
			)}
			<Switch
				label={i18n._("Scheduled backups enabled")}
				checked={enabled}
				onChange={(event) => changed(setEnabled)(event.currentTarget.checked)}
			/>
			{error && (
				<Text size="sm" c="red">
					{error}
				</Text>
			)}
			<Group justify="flex-end">
				<Button
					loading={saving}
					disabled={!destinationId || !extraValid}
					onClick={() =>
						destinationId &&
						onSave({
							destinationId,
							cron,
							keepLast,
							keepDays,
							...(manualRetention && { includeManual }),
							enabled,
						})
					}
				>
					{i18n._("Save schedule")}
				</Button>
			</Group>
		</Stack>
	);
};
