import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { jobTitle } from "#/config/job-titles.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { deployments } from "#/db/schema/server.ts";
import { appTaskRuns, appTasks, type TaskCommand } from "#/db/schema/tasks.ts";
import { users } from "#/db/schema/user.ts";
import {
	appLocation,
	appSecretValues,
	containerName,
	deployedServices,
	getAppRow,
	getAppServer,
} from "#/features/apps/apps.server.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import { type Actor, can, systemActor } from "#/features/auth/access.ts";
import {
	isAppBusy,
	type JobContext,
	type JobOutcome,
	onServerIdle,
	registerJobRecovery,
	startJob,
} from "#/features/deployments/deployments.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { errorInfo } from "#/libs/coded.ts";
import {
	isValidCron,
	minIntervalMinutes,
	nextRunAt,
	schedulerClock,
} from "#/libs/cron.ts";
import { appContainerCheckScript } from "#/server/services/apps/commands.ts";
import { audit } from "#/server/services/audit.ts";
import { errorColumns, errorInfoOf } from "#/server/services/error-info.ts";
import { emitEvent } from "#/server/services/events/bus.ts";
import { appLockKey } from "#/server/services/jobs/locks.ts";
import { schedule, unschedule } from "#/server/services/scheduler.ts";
import {
	appendTail,
	assertTaskCommand,
	classifyExit,
	createSecretMasker,
	oomDuringRun,
	oomStateCommand,
	TaskCommandError,
} from "#/server/services/tasks/commands.ts";
import { runTaskCommand } from "#/server/services/tasks/run.ts";
import { AppError } from "#/utils/error.ts";
import {
	TASK_ARGV_MAX,
	type TaskDTO,
	type TaskInput,
	type TaskLockPolicy,
	type TaskRunDTO,
	type TaskRunStatus,
	type TaskSettings,
	type TaskUpdateInput,
} from "./schema";

/**
 * Scheduled tasks per app (M8). A run is a job (`app_task`) on the app's
 * server: it takes the server lock, so it never runs during a deploy or a
 * backup. When the server is busy, a scheduled run is skipped (recorded)
 * or queued until the server is idle, per the task's lock policy. Runs are
 * kept with their output tail; failures emit `task.failed`.
 * Scheduler and queue are in-process (single instance, like backups).
 */

type TaskRow = typeof appTasks.$inferSelect;

const jobName = (taskId: string) => `task:${taskId}`;

export function taskSettings(now = new Date()): TaskSettings {
	const config = getConfig();
	return {
		defaultTimeoutSeconds: config.TASK_DEFAULT_TIMEOUT_SECONDS,
		maxTimeoutSeconds: config.TASK_MAX_TIMEOUT_SECONDS,
		defaultLockPolicy: config.TASK_LOCK_POLICY,
		...schedulerClock(now),
	};
}

function nextRun(task: Pick<TaskRow, "cron" | "enabled">): Date | null {
	return task.enabled ? nextRunAt(task.cron) : null;
}

/** Valid cron, no more often than TASK_MIN_INTERVAL_MINUTES. */
function assertTaskSchedule(cron: string, minMinutes: number): void {
	if (!isValidCron(cron)) throw new AppError("TASK_CRON_INVALID", { cron });
	if (minIntervalMinutes(cron, 3) < minMinutes) {
		throw new AppError("TASK_TOO_FREQUENT", { minutes: minMinutes });
	}
}

function commandOf(input: Pick<TaskInput, "mode" | "argv" | "shell">) {
	try {
		return assertTaskCommand(
			input.mode === "argv"
				? { argv: input.argv.filter((arg, index) => index === 0 || arg !== "") }
				: { shell: input.shell },
		);
	} catch (error) {
		if (!(error instanceof TaskCommandError)) throw error;
		switch (error.problem) {
			case "argv_count":
				throw new AppError("TASK_COMMAND_TOO_MANY_ARGS", {
					max: TASK_ARGV_MAX,
				});
			case "too_long":
				throw new AppError("TASK_COMMAND_TOO_LONG");
			case "nul":
				throw new AppError("TASK_COMMAND_NUL");
			default:
				throw new AppError("TASK_COMMAND_EMPTY");
		}
	}
}

function toDTO(
	row: TaskRow,
	lastRun: TaskDTO["lastRun"] | undefined,
	/** Viewers without app.tasks.manage do not see the command. */
	hideCommand = false,
): TaskDTO {
	return {
		commandHidden: hideCommand,
		id: row.id,
		appId: row.appId,
		name: row.name,
		service: row.service,
		mode: row.command.argv ? "argv" : "shell",
		argv: hideCommand ? [] : (row.command.argv ?? []),
		shell: hideCommand ? "" : (row.command.shell ?? ""),
		cron: row.cron,
		timeoutSeconds: row.timeoutSeconds,
		lockPolicy: (row.lockPolicy as TaskLockPolicy | null) ?? null,
		enabled: row.enabled,
		lastRunAt: row.lastRunAt,
		nextRunAt: nextRun(row),
		lastRun: lastRun ?? null,
		runsAs: null,
		createdAt: row.createdAt,
	};
}

async function getTaskRow(
	actor: Actor,
	appId: string,
	id: string,
	permission: "app.view" | "app.tasks.manage",
): Promise<{ app: AppRow; task: TaskRow }> {
	const app = await getAppRow(actor, appId, permission);
	const [task] = await db
		.select()
		.from(appTasks)
		.where(and(eq(appTasks.id, id), eq(appTasks.appId, app.id)))
		.limit(1);
	if (!task || task.teamId !== actor.teamId) {
		throw new AppError("TASK_NOT_FOUND");
	}
	return { app, task };
}

export async function listTasks(
	actor: Actor,
	appId: string,
): Promise<TaskDTO[]> {
	const app = await getAppRow(actor, appId);
	const rows = await db
		.select()
		.from(appTasks)
		.where(eq(appTasks.appId, app.id))
		.orderBy(appTasks.createdAt);
	if (rows.length === 0) return [];
	const latest = await db
		.selectDistinctOn([appTaskRuns.taskId], {
			taskId: appTaskRuns.taskId,
			status: appTaskRuns.status,
			startedAt: appTaskRuns.startedAt,
			exitCode: appTaskRuns.exitCode,
		})
		.from(appTaskRuns)
		.where(
			inArray(
				appTaskRuns.taskId,
				rows.map((row) => row.id),
			),
		)
		.orderBy(appTaskRuns.taskId, desc(appTaskRuns.startedAt));
	const byTask = new Map(latest.map((run) => [run.taskId, run]));
	const hide = !can(actor, "app.tasks.manage");
	const ownerIds = rows.flatMap((row) => (row.userId ? [row.userId] : []));
	const owners = new Map(
		(ownerIds.length === 0
			? []
			: await db
					.select({ id: users.id, email: users.email })
					.from(users)
					.where(inArray(users.id, ownerIds))
		).map((user) => [user.id, user.email]),
	);
	return rows.map((row) => ({
		...toDTO(row, byTask.get(row.id), hide),
		runsAs: row.userId ? (owners.get(row.userId) ?? null) : null,
	}));
}

function validate(app: AppRow, input: TaskInput): TaskCommand {
	const config = getConfig();
	if (!deployedServices(app).includes(input.service)) {
		throw new AppError("APP_SERVICE_NOT_FOUND", { service: input.service });
	}
	if (input.timeoutSeconds > config.TASK_MAX_TIMEOUT_SECONDS) {
		throw new AppError("TASK_TIMEOUT_TOO_LONG", {
			max: config.TASK_MAX_TIMEOUT_SECONDS,
		});
	}
	assertTaskSchedule(input.cron, config.TASK_MIN_INTERVAL_MINUTES);
	return commandOf(input);
}

export async function createTask(
	actor: Actor,
	input: TaskInput,
): Promise<TaskDTO> {
	const app = await getAppRow(actor, input.appId, "app.tasks.manage");
	const command = validate(app, input);
	const [{ count }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(appTasks)
		.where(eq(appTasks.appId, app.id));
	const max = getConfig().TASK_MAX_PER_APP;
	if (count >= max) throw new AppError("TASK_LIMIT", { max });
	const [row] = await db
		.insert(appTasks)
		.values({
			teamId: actor.teamId,
			appId: app.id,
			userId: actor.userId,
			name: input.name,
			service: input.service,
			command,
			cron: input.cron,
			timeoutSeconds: input.timeoutSeconds,
			lockPolicy: input.lockPolicy,
			enabled: input.enabled,
		})
		.returning();
	refreshTaskSchedule(row);
	audit({
		actor,
		action: "app.task.create",
		targetType: "app",
		targetId: app.id,
		meta: { task: row.name, service: row.service, cron: row.cron },
	});
	return toDTO(row, null);
}

export async function updateTask(
	actor: Actor,
	input: TaskUpdateInput,
): Promise<TaskDTO> {
	const { app, task } = await getTaskRow(
		actor,
		input.appId,
		input.id,
		"app.tasks.manage",
	);
	const command = validate(app, input);
	const [row] = await db
		.update(appTasks)
		.set({
			// Scheduled runs act as the member who last saved the task.
			userId: actor.userId,
			name: input.name,
			service: input.service,
			command,
			cron: input.cron,
			timeoutSeconds: input.timeoutSeconds,
			lockPolicy: input.lockPolicy,
			enabled: input.enabled,
			updatedAt: new Date(),
		})
		.where(eq(appTasks.id, task.id))
		.returning();
	refreshTaskSchedule(row);
	audit({
		actor,
		action: "app.task.update",
		targetType: "app",
		targetId: app.id,
		meta: {
			task: row.name,
			service: row.service,
			cron: row.cron,
			enabled: row.enabled,
		},
	});
	return toDTO(row, null);
}

export async function deleteTask(
	actor: Actor,
	ref: { appId: string; id: string },
): Promise<void> {
	const { app, task } = await getTaskRow(
		actor,
		ref.appId,
		ref.id,
		"app.tasks.manage",
	);
	unschedule(jobName(task.id));
	await db.delete(appTasks).where(eq(appTasks.id, task.id));
	audit({
		actor,
		action: "app.task.delete",
		targetType: "app",
		targetId: app.id,
		meta: { task: task.name },
	});
}

export async function listTaskRuns(
	actor: Actor,
	ref: { appId: string; id: string },
): Promise<TaskRunDTO[]> {
	const { task } = await getTaskRow(actor, ref.appId, ref.id, "app.view");
	// Output can hold anything the command printed: managers only.
	const showOutput = can(actor, "app.tasks.manage");
	const rows = await db
		.select({
			id: appTaskRuns.id,
			taskId: appTaskRuns.taskId,
			deploymentId: appTaskRuns.deploymentId,
			trigger: appTaskRuns.trigger,
			status: appTaskRuns.status,
			exitCode: appTaskRuns.exitCode,
			output: appTaskRuns.output,
			errorText: appTaskRuns.error,
			errorCode: appTaskRuns.errorCode,
			errorParams: appTaskRuns.errorParams,
			startedAt: appTaskRuns.startedAt,
			finishedAt: appTaskRuns.finishedAt,
			durationMs: appTaskRuns.durationMs,
		})
		.from(appTaskRuns)
		.where(eq(appTaskRuns.taskId, task.id))
		.orderBy(desc(appTaskRuns.startedAt))
		.limit(getConfig().TASK_RUNS_KEPT);
	return rows.map(({ errorText, errorCode, errorParams, ...row }) => ({
		...row,
		output: showOutput ? row.output : null,
		error: errorInfo(errorText, errorCode, errorParams),
	}));
}

/** "Run now": a manual run (fails with SERVER_BUSY while a job runs). */
export async function runTaskNow(
	actor: Actor,
	ref: { appId: string; id: string },
): Promise<{ deploymentId: string }> {
	const { app, task } = await getTaskRow(
		actor,
		ref.appId,
		ref.id,
		"app.tasks.manage",
	);
	audit({
		actor,
		action: "app.task.run",
		targetType: "app",
		targetId: app.id,
		meta: { task: task.name },
	});
	return startTaskRun(actor, app, task, "manual");
}

// ---------------------------------------------------------------------------
// Runs

async function finishRun(
	runId: string,
	patch: {
		status: TaskRunStatus;
		exitCode?: number | null;
		output?: string;
		error?: unknown;
		startedAt: number;
	},
): Promise<void> {
	await db
		.update(appTaskRuns)
		.set({
			status: patch.status,
			exitCode: patch.exitCode ?? null,
			output: patch.output ?? null,
			...errorColumns(patch.error ?? null),
			finishedAt: new Date(),
			durationMs: Date.now() - patch.startedAt,
		})
		.where(eq(appTaskRuns.id, runId));
}

/** Keep the newest TASK_RUNS_KEPT runs of a task. */
async function pruneRuns(taskId: string): Promise<void> {
	const keep = getConfig().TASK_RUNS_KEPT;
	const [cutoff] = await db
		.select({ startedAt: appTaskRuns.startedAt })
		.from(appTaskRuns)
		.where(eq(appTaskRuns.taskId, taskId))
		.orderBy(desc(appTaskRuns.startedAt))
		.offset(keep - 1)
		.limit(1);
	if (!cutoff) return;
	const removed = await db
		.delete(appTaskRuns)
		.where(
			and(
				eq(appTaskRuns.taskId, taskId),
				lt(appTaskRuns.startedAt, cutoff.startedAt),
			),
		)
		.returning({ deploymentId: appTaskRuns.deploymentId });
	// Their jobs and job logs go too (logs cascade).
	const jobs = removed
		.map((run) => run.deploymentId)
		.filter((id): id is string => !!id);
	if (jobs.length) {
		await db
			.delete(deployments)
			.where(
				and(
					inArray(deployments.id, jobs),
					inArray(deployments.status, ["success", "failed"]),
				),
			);
	}
}

function notifyFailure(
	app: AppRow,
	task: TaskRow,
	runId: string,
	status: TaskRunStatus,
	error: unknown,
): void {
	emitEvent({
		id: status === "skipped" ? "task.skipped" : "task.failed",
		teamId: app.teamId,
		userId: task.userId,
		subject: `${task.id}:${status}`,
		serverId: app.serverId,
		appId: app.id,
		params: {
			task: task.name,
			service: task.service,
			status,
			error: { $error: errorInfoOf(error) },
			run: runId,
		},
	});
}

async function executeRun(
	app: AppRow,
	task: TaskRow,
	trigger: "schedule" | "manual",
	ctx: JobContext,
): Promise<JobOutcome> {
	const config = getConfig();
	const startedAt = Date.now();
	const [run] = await db
		.insert(appTaskRuns)
		.values({
			taskId: task.id,
			teamId: task.teamId,
			appId: app.id,
			deploymentId: ctx.deploymentId,
			trigger,
		})
		.returning({ id: appTaskRuns.id });
	await db
		.update(appTasks)
		.set({ lastRunAt: new Date() })
		.where(eq(appTasks.id, task.id));

	// Output: secrets masked before anything is stored (tail and job log);
	// the job log takes at most TASK_LOG_MAX_LINES lines.
	const masker = createSecretMasker(await appSecretValues(app));
	let output = "";
	let logged = 0;
	let truncated = false;
	const record = (text: string) => {
		if (!text) return;
		output = appendTail(output, text, config.TASK_OUTPUT_MAX_BYTES);
		for (const line of text.split("\n")) {
			if (!line) continue;
			if (logged < config.TASK_LOG_MAX_LINES) {
				ctx.log(line);
				logged++;
			} else if (!truncated) {
				truncated = true;
				ctx.event("task.output_truncated", { max: config.TASK_LOG_MAX_LINES });
			}
		}
	};
	const collect = (chunk: string) => record(masker.push(chunk));

	const container = containerName(appLocation(app).folder, task.service);
	let status: TaskRunStatus = "failed";
	let error: unknown = null;
	let exitCode: number | null = null;
	const executor = await getExecutor(await getAppServer(app));
	try {
		// The command itself is not logged (viewers of the job log may not
		// see task commands).
		ctx.event("task.running", { task: task.name, service: task.service });
		const check = await executor.exec(
			appContainerCheckScript([container], app.id),
		);
		if (check.exitCode !== 0) {
			throw new AppError("TASK_CONTAINER_FOREIGN", {
				container,
				detail: check.stderr,
			});
		}
		const oomBefore =
			(await executor.exec(oomStateCommand(container)).catch(() => null))
				?.stdout ?? "";
		const run = await runTaskCommand(executor, {
			container,
			command: task.command,
			timeoutSeconds: task.timeoutSeconds,
			onOutput: collect,
			signal: ctx.signal,
		});
		if (!run.wrapped) {
			ctx.event("task.no_sh");
		}
		const timedOut = run.timedOut;
		const result = { exitCode: run.exitCode };
		record(masker.flush());
		exitCode = timedOut ? null : result.exitCode;
		const oom =
			result.exitCode !== 0 &&
			oomDuringRun(
				oomBefore,
				(await executor.exec(oomStateCommand(container)).catch(() => null))
					?.stdout ?? "",
			);
		const ending = classifyExit(result.exitCode, {
			oomKilled: oom,
			timedOut,
			overran: Date.now() - startedAt >= task.timeoutSeconds * 1000,
		});
		status = ending.status;
		const duration = { $ms: task.timeoutSeconds * 1000 };
		error =
			ending.status === "success"
				? null
				: ending.status === "timeout"
					? timedOut
						? new AppError("TASK_TIMEOUT_UNBOUNDED", { duration })
						: new AppError("TASK_TIMEOUT", { duration })
					: ending.status === "oom"
						? new AppError("TASK_OOM")
						: ending.status === "killed"
							? new AppError("TASK_KILLED", { signal: String(ending.signal) })
							: new AppError("TASK_EXIT_CODE", { code: ending.exitCode ?? -1 });
	} catch (failure) {
		record(masker.flush());
		status = "failed";
		error = failure;
	} finally {
		executor.close();
	}
	await finishRun(run.id, { status, exitCode, output, error, startedAt });
	await pruneRuns(task.id).catch(() => undefined);
	if (status !== "success") {
		const failure = new AppError("TASK_RUN_FAILED", {
			task: task.name,
			reason: { $error: errorInfoOf(error ?? new AppError("JOB_FAILED")) },
		});
		notifyFailure(app, task, run.id, status, error ?? failure);
		ctx.event("job.error", { error: { $error: errorInfoOf(failure) } });
		return { success: false, error: failure };
	}
	ctx.event("task.done", { task: task.name });
	return { success: true };
}

async function startTaskRun(
	actor: Actor,
	app: AppRow,
	task: TaskRow,
	trigger: "schedule" | "manual",
): Promise<{ deploymentId: string }> {
	if (!deployedServices(app).includes(task.service)) {
		throw new AppError("APP_SERVICE_NOT_FOUND", { service: task.service });
	}
	// App-scoped lock: jobs of other apps on the server are not blocked.
	return startJob(
		{
			actor,
			serverId: app.serverId,
			appId: app.id,
			type: "app_task",
			title: jobTitle("app_task", { task: task.name }),
			lock: "app",
		},
		(ctx) => executeRun(app, task, trigger, ctx),
	);
}

/** A run that did not happen (busy server, stopped app): recorded. */
async function recordSkipped(
	app: AppRow,
	task: TaskRow,
	reason: AppError,
): Promise<void> {
	const [run] = await db
		.insert(appTaskRuns)
		.values({
			taskId: task.id,
			teamId: task.teamId,
			appId: app.id,
			trigger: "schedule",
			status: "skipped",
			...errorColumns(reason),
			finishedAt: new Date(),
			durationMs: 0,
		})
		.returning({ id: appTaskRuns.id });
	await pruneRuns(task.id).catch(() => undefined);
	notifyFailure(app, task, run.id, "skipped", reason);
}

// ---------------------------------------------------------------------------
// Scheduling

interface QueuedRun {
	taskId: string;
	serverId: string;
	appId: string;
	since: number;
}

const queueState = globalThis as typeof globalThis & {
	__nitrobaseTaskQueue?: { waiting: QueuedRun[]; listening: boolean };
};
queueState.__nitrobaseTaskQueue ??= { waiting: [], listening: false };
const queue = queueState.__nitrobaseTaskQueue;

/**
 * Lock policy "queue": wait until neither the server (a job about this app
 * or the whole server) nor the app is busy. Every lock release retries the
 * runs it concerns; a run still blocked is queued again (same `since`).
 */
function enqueue(run: Omit<QueuedRun, "since">, since = Date.now()): void {
	if (!queue.waiting.some((item) => item.taskId === run.taskId)) {
		queue.waiting.push({ ...run, since });
	}
	if (queue.listening) return;
	queue.listening = true;
	onServerIdle(async (released) => {
		const ready = queue.waiting.filter(
			(item) =>
				(released === item.serverId || released === appLockKey(item.appId)) &&
				!isAppBusy(item.serverId, item.appId),
		);
		queue.waiting = queue.waiting.filter((item) => !ready.includes(item));
		for (const item of ready) {
			const waited = Date.now() - item.since;
			await runScheduledTask(item.taskId, {
				queuedSince: item.since,
				giveUp: waited > getConfig().TASK_QUEUE_MAX_WAIT_MS,
			});
		}
	});
}

/** A scheduled tick: run, or skip/queue when the server is busy. */
async function runScheduledTask(
	taskId: string,
	options: { queuedSince?: number; giveUp?: boolean } = {},
): Promise<void> {
	const [task] = await db
		.select()
		.from(appTasks)
		.where(eq(appTasks.id, taskId))
		.limit(1);
	if (!task) {
		// Deleted with its app (cascade): drop the timer too.
		unschedule(jobName(taskId));
		return;
	}
	if (!task.enabled) return;
	const [app] = await db
		.select()
		.from(apps)
		.where(eq(apps.id, task.appId))
		.limit(1);
	if (!app) return;
	const policy: TaskLockPolicy =
		(task.lockPolicy as TaskLockPolicy | null) ?? getConfig().TASK_LOCK_POLICY;
	if (options.giveUp) {
		await recordSkipped(
			app,
			task,
			new AppError("TASK_SKIPPED_WAITED", {
				duration: { $ms: Date.now() - (options.queuedSince ?? Date.now()) },
			}),
		);
		return;
	}
	if (app.status !== "running") {
		await recordSkipped(
			app,
			task,
			new AppError("TASK_SKIPPED_APP_STATE", { status: app.status }),
		);
		return;
	}
	try {
		if (isAppBusy(app.serverId, app.id)) throw new AppError("SERVER_BUSY");
		await startTaskRun(
			systemActor(task.teamId, task.userId),
			app,
			task,
			"schedule",
		);
	} catch (error) {
		if (error instanceof AppError && error.code === "SERVER_BUSY") {
			if (policy === "queue") {
				enqueue(
					{ taskId: task.id, serverId: app.serverId, appId: app.id },
					options.queuedSince,
				);
				return;
			}
			await recordSkipped(app, task, new AppError("TASK_SKIPPED_BUSY"));
			return;
		}
		if (error instanceof AppError && error.code === "INSTANCE_PAUSED") return;
		console.error(`[tasks] scheduled run of ${task.id} failed`, error);
	}
}

function refreshTaskSchedule(task: TaskRow): void {
	unschedule(jobName(task.id));
	if (!task.enabled) return;
	try {
		schedule(jobName(task.id), task.cron, () => runScheduledTask(task.id));
	} catch (error) {
		console.error(`[tasks] could not schedule ${task.id}`, error);
	}
}

/**
 * A member left or was removed: the tasks that run as them are disabled.
 * Whoever edits or re-enables a task becomes the member it runs as.
 */
export async function disableMemberTasks(
	teamId: string,
	userId: string,
): Promise<number> {
	const rows = await db
		.update(appTasks)
		.set({ enabled: false, updatedAt: new Date() })
		.where(
			and(
				eq(appTasks.teamId, teamId),
				eq(appTasks.userId, userId),
				eq(appTasks.enabled, true),
			),
		)
		.returning({ id: appTasks.id });
	for (const row of rows) unschedule(jobName(row.id));
	return rows.length;
}

/** Boot (and resume): register every enabled task. Missed runs are not caught up. */
export async function registerTaskSchedules(): Promise<void> {
	const tasks = await db
		.select()
		.from(appTasks)
		.where(eq(appTasks.enabled, true));
	for (const task of tasks) refreshTaskSchedule(task);
}

// Runs of jobs a dead process left `running` can never finish.
registerJobRecovery("tasks", {
	async onInterrupted(deploymentIds) {
		await db
			.update(appTaskRuns)
			.set({
				status: "failed",
				...errorColumns(new AppError("JOB_INTERRUPTED")),
				finishedAt: new Date(),
			})
			.where(
				and(
					inArray(appTaskRuns.deploymentId, deploymentIds),
					eq(appTaskRuns.status, "running"),
				),
			);
	},
});
