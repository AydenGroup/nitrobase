import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Card,
	Code,
	Group,
	Menu,
	Modal,
	NumberInput,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CalendarClock,
	History,
	MoreHorizontal,
	Pencil,
	Play,
	Plus,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { useCan } from "#/components/teams/useCan";
import { DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { ErrorText } from "#/components/ui/ErrorText.tsx";
import { LogViewer } from "#/components/ui/LogViewer";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { pollWhile } from "#/config/polling.ts";
import { TASK_DEFAULT_CRON } from "#/config/shared.ts";
import { isBusy, taskRunStatuses } from "#/config/status.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import type {
	TaskDTO,
	TaskInput,
	TaskLockPolicy,
	TaskMode,
	TaskSettings,
} from "#/features/tasks/schema.ts";
import {
	createTaskFn,
	deleteTaskFn,
	runTaskNowFn,
	updateTaskFn,
} from "#/features/tasks/tasks.functions.ts";
import {
	appTasksQueryOptions,
	taskRunsQueryOptions,
} from "#/features/tasks/tasks.query.ts";
import { nextRunAt } from "#/libs/cron.ts";
import {
	formatDate,
	formatDuration,
	formatRelativeTime,
	formatUtcOffset,
} from "#/libs/intl.ts";
import { logLinesFrom } from "#/libs/job-log.ts";
import { AppJobDrawer } from "./AppJobDrawer";
import { useAppJob } from "./useAppJob";

/** Schedule presets of the task form (cron in the server's time zone). */
const schedulePresets: { cron: string; label: MessageDescriptor }[] = [
	{ cron: "*/5 * * * *", label: msg({ id: "Every 5 minutes" }) },
	{ cron: "*/15 * * * *", label: msg({ id: "Every 15 minutes" }) },
	{ cron: "0 * * * *", label: msg({ id: "Every hour" }) },
	{ cron: "0 3 * * *", label: msg({ id: "Every day at 03:00" }) },
	{ cron: "0 3 * * 0", label: msg({ id: "Every Sunday at 03:00" }) },
];

const lockPolicyLabels = {
	skip: msg({ id: "Skip the run" }),
	queue: msg({ id: "Wait until the server is free" }),
} satisfies Record<TaskLockPolicy, MessageDescriptor>;

/**
 * App → Settings → Scheduled tasks (M8): commands run on a schedule inside
 * one of the app's service containers (docker exec), with run history.
 */
export const AppTasksCard: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { i18n } = useLingui();
	const can = useCan();
	const manage = can("app.tasks.manage");
	const { app } = overview;
	const queryClient = useQueryClient();
	const jobs = useAppJob(app.id);
	const query = useQuery(appTasksQueryOptions(app.id));
	const [editing, setEditing] = useState<TaskDTO | null | undefined>(undefined);
	const [historyOf, setHistoryOf] = useState<TaskDTO | null>(null);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["apps", app.id, "tasks"] });

	const toggle = useAppMutation({
		mutationFn: async (task: TaskDTO) =>
			await updateTaskFn({
				data: { ...taskInput(task), id: task.id, enabled: !task.enabled },
			}),
		onSuccess: refresh,
	});
	const remove = useAppMutation({
		mutationFn: async (task: TaskDTO) =>
			await deleteTaskFn({ data: { appId: app.id, id: task.id } }),
		success: i18n._("Scheduled task deleted"),
		onSuccess: refresh,
	});
	const confirmDelete = (task: TaskDTO) =>
		modals.openConfirmModal({
			title: i18n._("Delete {name}?", { name: task.name }),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._("The task and its run history are deleted.")}
				</Text>
			),
			labels: { confirm: i18n._("Delete"), cancel: i18n._("Cancel") },
			confirmProps: { color: "red" },
			onConfirm: () => remove.mutate(task),
		});

	const tasks = query.data?.tasks ?? [];
	const settings = query.data?.settings;
	const deployed = overview.services.length > 0;

	return (
		<Card withBorder p={0}>
			<Group justify="space-between" p="md" wrap="nowrap" align="flex-start">
				<div>
					<Title order={5}>{i18n._("Scheduled tasks")}</Title>
					<Text size="sm" c="dimmed">
						{i18n._(
							"Commands run on a schedule inside one of the app's containers (never on the server itself). A run waits for, or skips, other jobs on the server.",
						)}
					</Text>
				</div>
				{manage && (
					<Button
						size="xs"
						leftSection={<Plus size={14} />}
						disabled={!deployed}
						onClick={() => setEditing(null)}
					>
						{i18n._("Add task")}
					</Button>
				)}
			</Group>
			<DataTable
				rows={tasks}
				loading={query.isLoading}
				getRowKey={(task) => task.id}
				minWidth={640}
				empty={
					<EmptyState
						compact
						icon={CalendarClock}
						title={i18n._("No scheduled tasks")}
						description={
							deployed
								? i18n._(
										"For example a cleanup script, a cache warm-up or an export, every night.",
									)
								: i18n._("Deploy the app first, then add tasks.")
						}
					/>
				}
				columns={[
					{
						key: "name",
						header: i18n._("Task"),
						render: (task) => (
							<Stack gap={0}>
								<Text size="sm" fw={500}>
									{task.name}
								</Text>
								<Text size="xs" c="dimmed" ff="monospace" truncate maw={260}>
									{task.commandHidden
										? task.service
										: `${task.service} · ${task.mode === "argv" ? task.argv.join(" ") : task.shell}`}
								</Text>
								{task.runsAs && (
									<Text size="xs" c="dimmed">
										{i18n._("Runs as {member}", { member: task.runsAs })}
									</Text>
								)}
							</Stack>
						),
					},
					{
						key: "schedule",
						header: i18n._("Schedule"),
						render: (task) => (
							<Stack gap={0}>
								<Code>{task.cron}</Code>
								<Text size="xs" c="dimmed">
									{task.enabled && task.nextRunAt
										? i18n._("Next: {when}", {
												when: formatRelativeTime(i18n.locale, task.nextRunAt),
											})
										: i18n._("Paused")}
								</Text>
							</Stack>
						),
					},
					{
						key: "last",
						header: i18n._("Last run"),
						render: (task) =>
							task.lastRun ? (
								<Group gap={4} wrap="nowrap">
									<StatusBadge meta={taskRunStatuses[task.lastRun.status]} />
									<Text size="xs" c="dimmed">
										{formatRelativeTime(i18n.locale, task.lastRun.startedAt)}
									</Text>
								</Group>
							) : (
								<Text size="xs" c="dimmed">
									{i18n._("Never")}
								</Text>
							),
					},
					{
						key: "enabled",
						header: i18n._("Enabled"),
						render: (task) => (
							<Switch
								size="xs"
								checked={task.enabled}
								disabled={!manage || toggle.isPending}
								aria-label={i18n._("Enable {name}", { name: task.name })}
								onChange={() => toggle.mutate(task)}
							/>
						),
					},
					{
						key: "actions",
						header: "",
						align: "right",
						render: (task) => (
							<Group gap={4} justify="flex-end" wrap="nowrap">
								{manage && (
									<Tooltip label={i18n._("Run now")}>
										<ActionIcon
											variant="subtle"
											aria-label={i18n._("Run {name} now", { name: task.name })}
											loading={jobs.isStarting}
											onClick={() =>
												jobs.startJob({
													title: i18n._("Task {name}", { name: task.name }),
													start: () =>
														runTaskNowFn({
															data: { appId: app.id, id: task.id },
														}),
												})
											}
										>
											<Play size={16} />
										</ActionIcon>
									</Tooltip>
								)}
								<Tooltip label={i18n._("Run history")}>
									<ActionIcon
										variant="subtle"
										aria-label={i18n._("Run history of {name}", {
											name: task.name,
										})}
										onClick={() => setHistoryOf(task)}
									>
										<History size={16} />
									</ActionIcon>
								</Tooltip>
								{manage && (
									<Menu position="bottom-end">
										<Menu.Target>
											<ActionIcon
												variant="subtle"
												aria-label={i18n._("More actions for {name}", {
													name: task.name,
												})}
											>
												<MoreHorizontal size={16} />
											</ActionIcon>
										</Menu.Target>
										<Menu.Dropdown>
											<Menu.Item
												leftSection={<Pencil size={14} />}
												onClick={() => setEditing(task)}
											>
												{i18n._("Edit")}
											</Menu.Item>
											<Menu.Item
												color="red"
												leftSection={<Trash2 size={14} />}
												onClick={() => confirmDelete(task)}
											>
												{i18n._("Delete")}
											</Menu.Item>
										</Menu.Dropdown>
									</Menu>
								)}
							</Group>
						),
					},
				]}
			/>
			{settings && (
				<TaskFormModal
					opened={editing !== undefined}
					task={editing ?? null}
					overview={overview}
					settings={settings}
					onClose={() => setEditing(undefined)}
					onSaved={() => {
						setEditing(undefined);
						refresh();
					}}
				/>
			)}
			<TaskHistoryModal
				appId={app.id}
				task={historyOf}
				onClose={() => setHistoryOf(null)}
				onOpenJob={(id, title) => {
					setHistoryOf(null);
					jobs.openJob(id, title);
				}}
			/>
			<AppJobDrawer
				job={jobs.job}
				appName={app.name}
				onClose={jobs.closeJob}
				onCompleted={() => refresh()}
			/>
		</Card>
	);
};

function taskInput(task: TaskDTO): TaskInput {
	return {
		appId: task.appId,
		name: task.name,
		service: task.service,
		mode: task.mode,
		argv: task.argv,
		shell: task.shell,
		cron: task.cron,
		timeoutSeconds: task.timeoutSeconds,
		lockPolicy: task.lockPolicy,
		enabled: task.enabled,
	};
}

const TaskFormModal: React.FC<{
	opened: boolean;
	task: TaskDTO | null;
	overview: AppOverview;
	settings: TaskSettings;
	onClose: () => void;
	onSaved: () => void;
}> = ({ opened, task, overview, settings, onClose, onSaved }) => {
	const { i18n } = useLingui();
	const initial: TaskInput = task
		? taskInput(task)
		: {
				appId: overview.app.id,
				name: "",
				service: overview.services[0] ?? "",
				mode: "shell",
				argv: [],
				shell: "",
				cron: TASK_DEFAULT_CRON,
				timeoutSeconds: settings.defaultTimeoutSeconds,
				lockPolicy: null,
				enabled: true,
			};
	const [value, setValue] = useState<TaskInput>(initial);
	const [argvText, setArgvText] = useState(initial.argv.join("\n"));
	const [key, setKey] = useState<string | null>(null);
	// Reset when another task (or "new") is opened.
	const identity = `${task?.id ?? "new"}:${opened}`;
	if (key !== identity) {
		setKey(identity);
		setValue(initial);
		setArgvText(initial.argv.join("\n"));
	}
	const set = <K extends keyof TaskInput>(name: K, next: TaskInput[K]) =>
		setValue((prev) => ({ ...prev, [name]: next }));

	const save = useAppMutation({
		mutationFn: async () => {
			const data = {
				...value,
				argv: argvText.split("\n").map((line) => line.trimEnd()),
			};
			return task
				? await updateTaskFn({ data: { ...data, id: task.id } })
				: await createTaskFn({ data });
		},
		success: task
			? i18n._("Scheduled task saved")
			: i18n._("Scheduled task added"),
		field: "task",
		onSuccess: onSaved,
	});

	const next = nextRunAt(value.cron, { timezone: settings.timeZone });
	const preset = schedulePresets.find((item) => item.cron === value.cron);

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				task ? i18n._("Edit scheduled task") : i18n._("Add scheduled task")
			}
			size="lg"
		>
			<Stack gap="sm">
				<TextInput
					label={i18n._("Name")}
					placeholder={i18n._("Nightly cleanup")}
					value={value.name}
					onChange={(event) => set("name", event.currentTarget.value)}
					data-autofocus
				/>
				<Select
					label={i18n._("Run inside service")}
					data={overview.services}
					value={value.service}
					onChange={(service) => service && set("service", service)}
					allowDeselect={false}
				/>
				<div>
					<Text size="sm" fw={500} mb={4}>
						{i18n._("Command")}
					</Text>
					<SegmentedControl
						value={value.mode}
						onChange={(mode) => set("mode", mode as TaskMode)}
						data={[
							{ value: "shell", label: i18n._("Shell script (sh -c)") },
							{ value: "argv", label: i18n._("Program and arguments") },
						]}
					/>
				</div>
				{value.mode === "shell" ? (
					<Textarea
						description={i18n._(
							"Runs with sh -c inside the container (the image needs sh).",
						)}
						placeholder="php artisan schedule:run"
						autosize
						minRows={3}
						maxRows={12}
						ff="monospace"
						value={value.shell}
						onChange={(event) => set("shell", event.currentTarget.value)}
					/>
				) : (
					<Textarea
						description={i18n._(
							"One argument per line, run without a shell (works in images without sh).",
						)}
						placeholder={"/pb/pocketbase\nmigrate\nup"}
						autosize
						minRows={3}
						maxRows={12}
						ff="monospace"
						value={argvText}
						onChange={(event) => setArgvText(event.currentTarget.value)}
					/>
				)}
				<Group grow align="flex-start">
					<Select
						label={i18n._("Schedule")}
						data={[
							...schedulePresets.map((item) => ({
								value: item.cron,
								label: i18n._(item.label),
							})),
							{ value: "custom", label: i18n._("Custom (cron)") },
						]}
						value={preset ? preset.cron : "custom"}
						onChange={(choice) =>
							choice && choice !== "custom" && set("cron", choice)
						}
						allowDeselect={false}
					/>
					<TextInput
						label={i18n._("Cron expression")}
						ff="monospace"
						value={value.cron}
						onChange={(event) => set("cron", event.currentTarget.value)}
					/>
				</Group>
				<Text size="xs" c="dimmed">
					{next
						? i18n._("Next run: {date} (server time {zone}, {offset})", {
								date: formatDate(i18n.locale, next, {
									dateStyle: "full",
									timeStyle: "short",
								}),
								zone: settings.timeZone,
								offset: formatUtcOffset(settings.offsetMinutes),
							})
						: i18n._("Not a valid cron expression yet.")}
				</Text>
				<Group grow align="flex-start">
					<NumberInput
						label={i18n._("Timeout (seconds)")}
						min={1}
						max={settings.maxTimeoutSeconds}
						value={value.timeoutSeconds}
						onChange={(seconds) =>
							typeof seconds === "number" && set("timeoutSeconds", seconds)
						}
					/>
					<Select
						label={i18n._("When the server is busy")}
						description={i18n._("Another job (deploy, backup) is running.")}
						data={[
							{
								value: "default",
								label: i18n._("Default: {policy}", {
									policy: i18n._(lockPolicyLabels[settings.defaultLockPolicy]),
								}),
							},
							{ value: "skip", label: i18n._(lockPolicyLabels.skip) },
							{ value: "queue", label: i18n._(lockPolicyLabels.queue) },
						]}
						value={value.lockPolicy ?? "default"}
						onChange={(policy) =>
							set(
								"lockPolicy",
								policy === "skip" || policy === "queue" ? policy : null,
							)
						}
						allowDeselect={false}
					/>
				</Group>
				<Text size="xs" c="dimmed">
					{i18n._(
						"Scheduled runs act as the member who saves the task (you). If that member leaves the team, the task is disabled.",
					)}
				</Text>
				<Switch
					label={i18n._("Enabled")}
					checked={value.enabled}
					onChange={(event) => set("enabled", event.currentTarget.checked)}
				/>
				{save.fieldError() && (
					<Text size="sm" c="red">
						{save.fieldError()}
					</Text>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{i18n._("Cancel")}
					</Button>
					<Button loading={save.isPending} onClick={() => save.mutate()}>
						{task ? i18n._("Save") : i18n._("Add task")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};

const TaskHistoryModal: React.FC<{
	appId: string;
	task: TaskDTO | null;
	onClose: () => void;
	onOpenJob: (deploymentId: string, title: string) => void;
}> = ({ appId, task, onClose, onOpenJob }) => {
	const { i18n } = useLingui();
	const [open, setOpen] = useState<string | null>(null);
	const runs = useQuery({
		...taskRunsQueryOptions(appId, task?.id ?? ""),
		enabled: !!task,
		refetchInterval: (query) =>
			pollWhile(
				!!query.state.data?.some((run) => isBusy(taskRunStatuses, run.status)),
			),
	});
	return (
		<Modal
			opened={!!task}
			onClose={onClose}
			title={i18n._("Run history: {name}", { name: task?.name ?? "" })}
			size="xl"
		>
			<DataTable
				rows={runs.data ?? []}
				loading={runs.isLoading}
				getRowKey={(run) => run.id}
				minWidth={560}
				onRowClick={(run) =>
					setOpen((current) => (current === run.id ? null : run.id))
				}
				empty={
					<Text size="sm" c="dimmed" p="md">
						{i18n._("No runs yet.")}
					</Text>
				}
				columns={[
					{
						key: "started",
						header: i18n._("Started"),
						render: (run) => (
							<Stack gap={2}>
								<Text size="sm">
									{formatDate(i18n.locale, run.startedAt, {
										dateStyle: "medium",
										timeStyle: "short",
									})}
								</Text>
								{open === run.id && (
									<Stack gap={4}>
										<ErrorText size="xs" c="red" error={run.error} />
										{/* Clicks in the output (copy, select) keep the row open. */}
										<Box onClick={(event) => event.stopPropagation()}>
											<LogViewer
												entries={logLinesFrom(run.output ?? "").map(
													(line, index) => ({ key: index, line }),
												)}
												format="raw"
												autoHeight
												toolbar={{ copy: true }}
												emptyText={i18n._("(no output)")}
											/>
										</Box>
									</Stack>
								)}
							</Stack>
						),
					},
					{
						key: "status",
						header: i18n._("Status"),
						render: (run) => (
							<Group gap={4} wrap="nowrap">
								<StatusBadge meta={taskRunStatuses[run.status]} />
								{run.exitCode !== null && (
									<Badge size="xs" variant="outline" color="gray">
										{i18n._("exit {code}", { code: run.exitCode })}
									</Badge>
								)}
							</Group>
						),
					},
					{
						key: "trigger",
						header: i18n._("Trigger"),
						render: (run) =>
							run.trigger === "manual" ? i18n._("Manual") : i18n._("Schedule"),
					},
					{
						key: "duration",
						header: i18n._("Duration"),
						render: (run) => formatDuration(i18n.locale, run.durationMs),
					},
					{
						key: "job",
						header: i18n._("Job log"),
						render: (run) =>
							run.deploymentId ? (
								<Button
									size="compact-xs"
									variant="subtle"
									onClick={(event) => {
										event.stopPropagation();
										onOpenJob(
											run.deploymentId as string,
											i18n._("Task {name}", { name: task?.name ?? "" }),
										);
									}}
								>
									{i18n._("View log")}
								</Button>
							) : (
								<Tooltip
									label={i18n._(
										"No job log: the run was skipped or its log was removed by job retention.",
									)}
								>
									<Text size="xs" c="dimmed">
										—
									</Text>
								</Tooltip>
							),
					},
				]}
			/>
			<Text size="xs" c="dimmed" mt="xs">
				{i18n._("Click a run to see its output (the last part is kept).")}
			</Text>
		</Modal>
	);
};
