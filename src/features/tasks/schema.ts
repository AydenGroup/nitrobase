import type { I18n } from "@lingui/core";
import { z } from "zod";
import type { ErrorInfo } from "#/libs/coded.ts";

/** Scheduled tasks per app (M8): client-safe schemas and DTOs. */

export const TASK_ARGV_MAX = 64;
export const TASK_ARG_MAX_LENGTH = 4096;
export const TASK_SHELL_MAX_LENGTH = 16_384;

export const TASK_LOCK_POLICIES = ["skip", "queue"] as const;
export type TaskLockPolicy = (typeof TASK_LOCK_POLICIES)[number];

const TASK_MODES = ["argv", "shell"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export type TaskRunStatus =
	| "running"
	| "success"
	| "failed"
	| "skipped"
	| "timeout"
	| "oom"
	| "killed";

const serviceName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);

export const TaskInputSchema = (i18n: I18n) =>
	z
		.object({
			appId: z.guid(),
			name: z
				.string()
				.trim()
				.min(1, i18n._("Enter a name"))
				.max(80, i18n._("Use at most 80 characters")),
			service: serviceName,
			mode: z.enum(TASK_MODES),
			/** `argv` mode: program and arguments, one per item. */
			argv: z
				.array(z.string().max(TASK_ARG_MAX_LENGTH))
				.max(TASK_ARGV_MAX)
				.default([]),
			/** `shell` mode: script for `sh -c` inside the container. */
			shell: z.string().max(TASK_SHELL_MAX_LENGTH).default(""),
			cron: z.string().trim().min(1, i18n._("Enter a schedule")).max(120),
			timeoutSeconds: z.coerce
				.number()
				.int()
				.min(1)
				.max(7 * 24 * 3600),
			/** null = the instance default (TASK_LOCK_POLICY). */
			lockPolicy: z.enum(TASK_LOCK_POLICIES).nullable().default(null),
			enabled: z.boolean().default(true),
		})
		.superRefine((value, ctx) => {
			if (value.mode === "argv" && !value.argv[0]?.trim()) {
				ctx.addIssue({
					code: "custom",
					path: ["argv"],
					message: i18n._("Enter the program to run"),
				});
			}
			if (value.mode === "shell" && !value.shell.trim()) {
				ctx.addIssue({
					code: "custom",
					path: ["shell"],
					message: i18n._("Enter a command"),
				});
			}
		});
export type TaskInput = z.infer<ReturnType<typeof TaskInputSchema>>;

export const TaskUpdateSchema = (i18n: I18n) =>
	z.intersection(TaskInputSchema(i18n), z.object({ id: z.guid() }));
export type TaskUpdateInput = z.infer<ReturnType<typeof TaskUpdateSchema>>;

export const TaskRefSchema = z.object({ appId: z.guid(), id: z.guid() });

export interface TaskDTO {
	id: string;
	/** The viewer may not see the command (needs app.tasks.manage). */
	commandHidden: boolean;
	appId: string;
	name: string;
	service: string;
	mode: TaskMode;
	argv: string[];
	shell: string;
	cron: string;
	timeoutSeconds: number;
	lockPolicy: TaskLockPolicy | null;
	enabled: boolean;
	lastRunAt: Date | null;
	nextRunAt: Date | null;
	lastRun: {
		status: TaskRunStatus;
		startedAt: Date;
		exitCode: number | null;
	} | null;
	/** Email of the member scheduled runs act as (who last saved it). */
	runsAs: string | null;
	createdAt: Date;
}

export interface TaskRunDTO {
	id: string;
	taskId: string;
	deploymentId: string | null;
	trigger: "schedule" | "manual";
	status: TaskRunStatus;
	exitCode: number | null;
	output: string | null;
	/** Why it failed or was skipped (coded). */
	error: ErrorInfo | null;
	startedAt: Date;
	finishedAt: Date | null;
	durationMs: number | null;
}

/** Instance defaults the form shows. */
export interface TaskSettings {
	defaultTimeoutSeconds: number;
	maxTimeoutSeconds: number;
	defaultLockPolicy: TaskLockPolicy;
	timeZone: string;
	offsetMinutes: number;
}
