import { useLingui } from "@lingui/react";
import { Button, Grid, Select, Stack, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup } from "lucide-react";
import { useState } from "react";
import { AppJobDrawer } from "#/components/apps/AppJobDrawer";
import { useAppJob } from "#/components/apps/useAppJob";
import { useCan } from "#/components/teams/useCan";
import { EmptyState } from "#/components/ui/EmptyState";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { pollWhile } from "#/config/polling.ts";
import { backupStatuses, isBusy } from "#/config/status.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import {
	runBackupFn,
	saveAppPolicyFn,
} from "#/features/backups/backups.functions.ts";
import {
	appBackupSummaryQueryOptions,
	appPolicyQueryOptions,
	backupsQueryOptions,
	destinationsQueryOptions,
} from "#/features/backups/backups.query.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatDate, formatDuration } from "#/libs/intl.ts";
import { BackupsTable } from "./BackupsTable";
import { PolicyEditor, type PolicyValues } from "./PolicyEditor";

export const AppBackupsTab: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { i18n } = useLingui();
	const can = useCan();
	const { app } = overview;
	const queryClient = useQueryClient();
	const jobs = useAppJob(app.id);
	const destinations = useQuery(destinationsQueryOptions);
	const policy = useQuery(appPolicyQueryOptions(app.id));
	const summary = useQuery(appBackupSummaryQueryOptions(app.id));
	const runs = useQuery({
		...backupsQueryOptions({ appId: app.id }),
		refetchInterval: (query) =>
			pollWhile(
				!!query.state.data?.some((row) => isBusy(backupStatuses, row.status)),
			),
	});

	const save = useAppMutation({
		mutationFn: async (values: PolicyValues) =>
			await saveAppPolicyFn({ data: { appId: app.id, ...values } }),
		success: i18n._("Backup schedule saved"),
		field: "policy",
		onSuccess: (data) =>
			queryClient.setQueryData(appPolicyQueryOptions(app.id).queryKey, data),
	});

	const deployed = overview.services.length > 0;
	const [pickedDestination, setManualDestination] = useState<string | null>(
		null,
	);
	const manualDestination =
		pickedDestination ??
		summary.data?.defaultDestinationId ??
		policy.data?.destinationId ??
		destinations.data?.[0]?.id ??
		null;
	const startBackup = (destinationId: string) =>
		jobs.startJob({
			title: i18n._("Backup"),
			start: () =>
				runBackupFn({
					data: { appId: app.id, destinationId },
				}),
		});
	// Templates that stop services for a consistent copy: say so first.
	const confirmBackup = (destinationId: string) => {
		if (!summary.data?.stopsApp || app.status !== "running") {
			startBackup(destinationId);
			return;
		}
		const seconds = summary.data.estimatedSeconds;
		modals.openConfirmModal({
			title: i18n._("Back up now"),
			centered: true,
			children: (
				<Text size="sm">
					{seconds
						? i18n._(
								"{app} stops while its data is copied, so the copy is consistent. Expect about {duration} of downtime (based on recent backups); it starts again automatically.",
								{
									app: app.name,
									duration: formatDuration(i18n.locale, seconds * 1000),
								},
							)
						: i18n._(
								"{app} stops while its data is copied, so the copy is consistent. This usually takes seconds to a few minutes depending on the data size; it starts again automatically.",
								{ app: app.name },
							)}
				</Text>
			),
			labels: {
				confirm: i18n._("Stop and back up"),
				cancel: i18n._("Cancel"),
			},
			onConfirm: () => startBackup(destinationId),
		});
	};
	if (destinations.data && destinations.data.length === 0) {
		return (
			<EmptyState
				withCard
				icon={DatabaseBackup}
				title={i18n._("No backup destination yet")}
				description={i18n._(
					"Add a destination (a server folder, S3, R2 or B2) to back up this app.",
				)}
			>
				{can("destination.manage") && (
					<Button component={LocalizedLink} to="/destinations" mt="xs">
						{i18n._("Add a destination")}
					</Button>
				)}
			</EmptyState>
		);
	}

	return (
		<Stack gap="md">
			<Grid gap="md">
				<Grid.Col span={{ base: 12, md: 7 }}>
					<SectionCard
						title={i18n._("Schedule & retention")}
						description={
							policy.data?.nextRunAt
								? i18n._("Next run: {date}", {
										date: formatDate(i18n.locale, policy.data.nextRunAt, {
											dateStyle: "medium",
											timeStyle: "short",
										}),
									})
								: i18n._("Not scheduled")
						}
					>
						{destinations.data &&
							policy.isFetched &&
							can("backup.policy.manage") && (
								<PolicyEditor
									key={policy.data?.id ?? "new"}
									policy={policy.data ?? null}
									destinations={destinations.data}
									manualRetention
									saving={save.isPending}
									error={save.fieldError()}
									onChange={save.clearFieldError}
									onSave={(values) => save.mutate(values)}
								/>
							)}
					</SectionCard>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 5 }}>
					<SectionCard
						title={i18n._("Back up now")}
						description={i18n._(
							"A full backup: database dump (when the template provides one), data folders and volumes, settings (encrypted) and the compose file.",
						)}
					>
						<Stack gap="xs">
							<Select
								label={i18n._("Destination")}
								data={(destinations.data ?? []).map((item) => ({
									value: item.id,
									label: item.name,
								}))}
								value={manualDestination}
								onChange={setManualDestination}
								allowDeselect={false}
							/>
							<Button
								leftSection={<DatabaseBackup size={16} />}
								display={can("backup.create") ? undefined : "none"}
								disabled={!deployed || !manualDestination}
								loading={jobs.isStarting}
								onClick={() =>
									manualDestination && confirmBackup(manualDestination)
								}
							>
								{i18n._("Back up now")}
							</Button>
							{summary.data?.stopsApp && (
								<Text size="xs" c="orange">
									{i18n._(
										"This app is stopped during backups for a consistent copy.",
									)}
								</Text>
							)}
							<Text size="xs" c="dimmed">
								{policy.data?.includeManual &&
								policy.data.destinationId === manualDestination
									? i18n._(
											"Counted by the schedule's retention rules on this destination.",
										)
									: i18n._("Manual backups are kept until you delete them.")}
							</Text>
						</Stack>
					</SectionCard>
				</Grid.Col>
			</Grid>
			<SectionCard title={i18n._("Backups")} flush>
				<BackupsTable
					backups={runs.data ?? []}
					loading={runs.isLoading}
					showApp={false}
				/>
			</SectionCard>
			<AppJobDrawer
				job={jobs.job}
				appName={app.name}
				onClose={jobs.closeJob}
				onCompleted={() => {
					jobs.refresh();
					queryClient.invalidateQueries({ queryKey: ["backups"] });
					queryClient.invalidateQueries({
						queryKey: appBackupSummaryQueryOptions(app.id).queryKey,
					});
				}}
			/>
		</Stack>
	);
};
