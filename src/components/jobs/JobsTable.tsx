import { useLingui } from "@lingui/react";
import {
	Anchor,
	Button,
	Group,
	type MantineColor,
	Stack,
	Text,
	ThemeIcon,
} from "@mantine/core";
import {
	Activity,
	AppWindow,
	Archive,
	Database,
	ScrollText,
	Server,
	TerminalSquare,
} from "lucide-react";
import type React from "react";
import { useState } from "react";

import { DeploymentStatusBadge } from "#/components/dashboard/StatusBadge";
import { ActionLogDrawer } from "#/components/servers/ActionLogDrawer";
import { DataTable } from "#/components/ui/DataTable";
import { ErrorText } from "#/components/ui/ErrorText.tsx";
import { titleFor } from "#/config/job-titles.ts";
import { sessionJobTypes } from "#/config/status.ts";
import type { JobListItem } from "#/features/deployments/schema.ts";
import { errorInfo } from "#/libs/coded.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatDate, formatDuration, formatRelativeTime } from "#/libs/intl.ts";

type JobVisualIcon = typeof Activity;

interface IJobVisual {
	icon: JobVisualIcon;
	color: MantineColor;
}

export function getJobVisual(type: string): IJobVisual {
	if (type === "terminal" || type === "app_terminal") {
		return { icon: TerminalSquare, color: "gray" };
	}
	if (type.includes("database")) {
		return { icon: Database, color: "violet" };
	}
	if (
		type.includes("backup") ||
		type.includes("restore") ||
		type.includes("export") ||
		type.includes("import")
	) {
		return { icon: Archive, color: "cyan" };
	}
	if (type === "bootstrap" || type === "connection_test") {
		return { icon: Server, color: "teal" };
	}
	if (
		type.startsWith("app_") ||
		type.includes("deploy") ||
		type.includes("build")
	) {
		return { icon: AppWindow, color: "blue" };
	}
	return { icon: Activity, color: "gray" };
}

interface IJobsTableProps {
	jobs: JobListItem[];
	loading?: boolean;
	showTarget?: boolean;
	onCompleted?: () => void;
}

/** Jobs list with a reopenable log drawer (used by global and entity pages). */
export const JobsTable: React.FC<IJobsTableProps> = ({
	jobs,
	loading,
	showTarget = true,
	onCompleted,
}) => {
	const { i18n } = useLingui();
	const [open, setOpen] = useState<JobListItem | null>(null);
	const title = (job: JobListItem) => titleFor(i18n, job);

	return (
		<>
			<DataTable
				rows={jobs}
				loading={loading}
				layout="fixed"
				getRowKey={(job) => job.id}
				defaultSort={{ key: "started", direction: "desc" }}
				empty={
					<Text c="dimmed" size="sm" p="md">
						{i18n._("No jobs yet.")}
					</Text>
				}
				columns={[
					{
						key: "job",
						header: i18n._("Job"),
						sortValue: (job) => title(job),
						render: (job) => {
							const visual = getJobVisual(job.type);
							const Icon = visual.icon;
							return (
								<Group
									gap="sm"
									wrap="nowrap"
									align="center"
									style={{ minWidth: 0, overflow: "hidden" }}
								>
									<ThemeIcon
										variant="light"
										color={visual.color}
										size="md"
										radius="md"
										style={{ flexShrink: 0 }}
									>
										<Icon size={16} />
									</ThemeIcon>
									<Stack
										gap={2}
										style={{ minWidth: 0, flex: 1, overflow: "hidden" }}
									>
										<Text size="sm" fw={500} truncate>
											{title(job)}
										</Text>
										{job.status === "failed" ? (
											<ErrorText
												size="xs"
												c="red"
												lineClamp={1}
												withDetail={false}
												error={errorInfo(
													job.errorMessage,
													job.errorCode,
													job.errorParams,
												)}
											/>
										) : (
											<Text size="xs" c="dimmed" ff="monospace">
												#{job.id.slice(0, 8)}
											</Text>
										)}
									</Stack>
								</Group>
							);
						},
					},
					...(showTarget
						? [
								{
									key: "target",
									header: i18n._("Target"),
									width: 170,
									sortValue: (job: JobListItem) =>
										job.appName ?? job.serverName ?? "",
									render: (job: JobListItem) => {
										if (job.appId && job.appName) {
											return (
												<Group gap={6} wrap="nowrap">
													<AppWindow
														size={14}
														style={{ flexShrink: 0, opacity: 0.6 }}
													/>
													<Anchor
														component={LocalizedLink}
														to={`/apps/${job.appId}`}
														size="sm"
														truncate
														onClick={(e: React.MouseEvent) =>
															e.stopPropagation()
														}
													>
														{job.appName}
													</Anchor>
												</Group>
											);
										}
										return (
											<Group gap={6} wrap="nowrap">
												<Server
													size={14}
													style={{ flexShrink: 0, opacity: 0.6 }}
												/>
												<Anchor
													component={LocalizedLink}
													to={`/servers/${job.serverId}`}
													size="sm"
													truncate
													onClick={(e: React.MouseEvent) => e.stopPropagation()}
												>
													{job.serverName ?? "—"}
												</Anchor>
											</Group>
										);
									},
								},
							]
						: []),
					{
						key: "status",
						header: i18n._("Status"),
						width: 140,
						sortValue: (job) => job.status,
						render: (job) => (
							<div style={{ whiteSpace: "nowrap" }}>
								<DeploymentStatusBadge
									status={job.status}
									warningCount={job.warningCount}
								/>
							</div>
						),
					},
					{
						key: "started",
						header: i18n._("Started"),
						width: 190,
						sortValue: (job) => new Date(job.createdAt),
						render: (job) => {
							const created = new Date(job.createdAt);
							const updated = new Date(job.updatedAt);
							const durationMs = updated.getTime() - created.getTime();
							return (
								<Stack gap={1}>
									<Text size="sm" style={{ whiteSpace: "nowrap" }}>
										{formatDate(i18n.locale, job.createdAt)}
									</Text>
									<Group gap={6} wrap="nowrap">
										<Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
											{formatRelativeTime(i18n.locale, job.createdAt)}
										</Text>
										{durationMs >= 1000 && job.status !== "running" && (
											<>
												<Text size="xs" c="dimmed">
													·
												</Text>
												<Text
													size="xs"
													c="dimmed"
													style={{ whiteSpace: "nowrap" }}
												>
													{formatDuration(i18n.locale, durationMs)}
												</Text>
											</>
										)}
									</Group>
								</Stack>
							);
						},
					},
					{
						key: "actions",
						header: "",
						width: 130,
						align: "right",
						render: (job) => {
							if (sessionJobTypes.has(job.type)) {
								return (
									<Text size="xs" c="dimmed" fs="italic" ta="right">
										{i18n._("Interactive")}
									</Text>
								);
							}
							return (
								<Button
									size="xs"
									variant={job.status === "running" ? "light" : "subtle"}
									leftSection={<ScrollText size={13} />}
									onClick={(e: React.MouseEvent) => {
										e.stopPropagation();
										setOpen(job);
									}}
								>
									{job.status === "running"
										? i18n._("Watch live")
										: i18n._("View logs")}
								</Button>
							);
						},
					},
				]}
			/>
			<ActionLogDrawer
				opened={open !== null}
				onClose={() => setOpen(null)}
				serverName={open?.appName ?? open?.serverName ?? ""}
				title={open ? title(open) : undefined}
				deploymentId={open?.id ?? null}
				onCompleted={() => onCompleted?.()}
			/>
		</>
	);
};
