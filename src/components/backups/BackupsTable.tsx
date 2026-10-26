import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Anchor,
	Badge,
	Group,
	Menu,
	Text,
	Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQueryClient } from "@tanstack/react-query";
import { Download, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { AppJobDrawer } from "#/components/apps/AppJobDrawer";
import { useCan } from "#/components/teams/useCan";
import { type DataColumn, DataTable } from "#/components/ui/DataTable";
import { ErrorText } from "#/components/ui/ErrorText.tsx";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { DATABASE_TEMPLATE_ID } from "#/config/database-engines.ts";
import {
	databaseRowRequirements,
	type Permission,
} from "#/config/permissions.ts";
import { APP_NAME } from "#/config/shared.ts";
import { backupStatuses } from "#/config/status.ts";
import {
	deleteBackupFn,
	verifyBackupFn,
} from "#/features/backups/backups.functions.ts";
import type { BackupDTO } from "#/features/backups/schema.ts";
import { errorInfo } from "#/libs/coded.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatBytes, formatDate, formatDuration } from "#/libs/intl.ts";
import { RestoreModal } from "./RestoreModal";

/** Backup runs with download, restore and delete. */
export const BackupsTable: React.FC<{
	backups: BackupDTO[];
	loading?: boolean;
	/** Show the app column (global list). */
	showApp?: boolean;
}> = ({ backups, loading, showApp = true }) => {
	const { i18n } = useLingui();
	const canInTeam = useCan();
	// A database backup needs the database permissions too (central mapping).
	const can = (permission: Permission, backup?: BackupDTO) =>
		backup?.templateId === DATABASE_TEMPLATE_ID
			? databaseRowRequirements(permission).every(canInTeam)
			: canInTeam(permission);
	const queryClient = useQueryClient();
	const [restoring, setRestoring] = useState<BackupDTO | null>(null);
	const [job, setJob] = useState<{ id: string; title: string } | null>(null);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["backups"] });

	const remove = useAppMutation({
		mutationFn: async (id: string) => await deleteBackupFn({ data: { id } }),
		success: i18n._("Backup deleted"),
		onSuccess: refresh,
	});
	const verify = useAppMutation({
		mutationFn: async (backup: BackupDTO) => ({
			backup,
			started: await verifyBackupFn({ data: { id: backup.id } }),
		}),
		onSuccess: ({ started }) =>
			setJob({ id: started.deploymentId, title: i18n._("Verify backup") }),
	});
	const confirmDelete = (backup: BackupDTO) =>
		modals.openConfirmModal({
			title: i18n._("Delete backup"),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._("The archive is deleted from {destination}.", {
						destination: backup.destinationName ?? "",
					})}
				</Text>
			),
			labels: { confirm: i18n._("Delete"), cancel: i18n._("Cancel") },
			confirmProps: { color: "red" },
			onConfirm: () => remove.mutate(backup.id),
		});

	const columns: DataColumn<BackupDTO>[] = [
		{
			key: "created",
			header: i18n._("Created"),
			sortValue: (row) => new Date(row.createdAt),
			render: (row) => (
				<Text size="sm">
					{formatDate(i18n.locale, row.createdAt, {
						dateStyle: "medium",
						timeStyle: "short",
					})}
				</Text>
			),
		},
		...(showApp
			? [
					{
						key: "app",
						header: i18n._("App"),
						sortValue: (row: BackupDTO) => row.appName ?? "",
						render: (row: BackupDTO) =>
							row.appId ? (
								<Anchor
									component={LocalizedLink}
									to={`/apps/${row.appId}`}
									search={{ tab: "backups" } as never}
									size="sm"
								>
									{row.appName}
								</Anchor>
							) : (
								<Text size="sm">{row.appName}</Text>
							),
					},
				]
			: []),
		{
			key: "status",
			header: i18n._("Status"),
			render: (row) => (
				<Group gap={6} wrap="nowrap">
					<StatusBadge meta={backupStatuses[row.status]} size="xs" />
					{row.trigger === "schedule" && (
						<Badge size="xs" variant="outline" color="gray">
							{i18n._("scheduled")}
						</Badge>
					)}
					{row.kind === "panel" && (
						<Badge size="xs" variant="outline">
							{APP_NAME}
						</Badge>
					)}
					{row.verifiedAt && row.status === "success" && (
						<Tooltip
							label={i18n._("Verified {date}", {
								date: formatDate(i18n.locale, row.verifiedAt, {
									dateStyle: "medium",
									timeStyle: "short",
								}),
							})}
						>
							<Badge size="xs" variant="light" color="green">
								{i18n._("verified")}
							</Badge>
						</Tooltip>
					)}
				</Group>
			),
		},
		{
			key: "size",
			header: i18n._("Size"),
			align: "right",
			sortValue: (row) => row.sizeBytes ?? 0,
			render: (row) => formatBytes(i18n.locale, row.sizeBytes),
		},
		{
			key: "duration",
			header: i18n._("Duration"),
			align: "right",
			hideOnMobile: true,
			render: (row) => formatDuration(i18n.locale, row.durationMs),
		},
		{
			key: "checksum",
			header: "sha256",
			hideOnMobile: true,
			render: (row) =>
				row.checksum ? (
					<Tooltip label={row.checksum}>
						<Text size="xs" ff="monospace">
							{row.checksum.slice(0, 12)}…
						</Text>
					</Tooltip>
				) : row.error || row.errorCode ? (
					<ErrorText
						size="xs"
						c="red"
						lineClamp={2}
						error={errorInfo(row.error, row.errorCode, row.errorParams)}
					/>
				) : (
					"—"
				),
		},
		{
			key: "destination",
			header: i18n._("Destination"),
			hideOnMobile: true,
			render: (row) => row.destinationName ?? "—",
		},
		{
			key: "actions",
			header: "",
			align: "right",
			render: (row) => (
				<Group gap={4} justify="flex-end" wrap="nowrap">
					{row.status === "success" && can("backup.download", row) && (
						<Tooltip label={i18n._("Download")}>
							<ActionIcon
								component="a"
								href={`/api/backups/${row.id}/download`}
								variant="subtle"
								aria-label={i18n._("Download")}
							>
								<Download size={16} />
							</ActionIcon>
						</Tooltip>
					)}
					<Menu position="bottom-end">
						<Menu.Target>
							<ActionIcon variant="subtle" aria-label={i18n._("More actions")}>
								<MoreHorizontal size={16} />
							</ActionIcon>
						</Menu.Target>
						<Menu.Dropdown>
							{row.status === "success" &&
								row.kind !== "panel" &&
								can("backup.restore", row) && (
									<Menu.Item onClick={() => setRestoring(row)}>
										{i18n._("Restore…")}
									</Menu.Item>
								)}
							{(row.status === "success" || row.status === "corrupt") &&
								row.checksum &&
								can("backup.create") && (
									<Menu.Item onClick={() => verify.mutate(row)}>
										{i18n._("Verify archive")}
									</Menu.Item>
								)}
							{row.deploymentId && (
								<Menu.Item
									onClick={() =>
										setJob({
											id: row.deploymentId as string,
											title: i18n._("Backup"),
										})
									}
								>
									{i18n._("View log")}
								</Menu.Item>
							)}
							{row.status !== "running" && can("backup.delete") && (
								<Menu.Item color="red" onClick={() => confirmDelete(row)}>
									{i18n._("Delete")}
								</Menu.Item>
							)}
						</Menu.Dropdown>
					</Menu>
				</Group>
			),
		},
	];

	return (
		<>
			<DataTable
				rows={backups}
				loading={loading}
				getRowKey={(row) => row.id}
				defaultSort={{ key: "created", direction: "desc" }}
				columns={columns}
				empty={
					<Text c="dimmed" size="sm" p="md">
						{i18n._("No backups yet.")}
					</Text>
				}
			/>
			<RestoreModal
				backup={restoring}
				onClose={() => setRestoring(null)}
				onStarted={(id, title) => setJob({ id, title })}
			/>
			<AppJobDrawer
				job={job}
				appName={restoring?.appName ?? ""}
				onClose={() => setJob(null)}
				onCompleted={refresh}
			/>
		</>
	);
};
