import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type { CodedParams } from "#/libs/coded.ts";
import { apps } from "./apps";
import { deployments } from "./server";
import { teams } from "./teams";
import { users } from "./user";

/**
 * Scheduled tasks per app (M8): a command run inside one service container
 * (`docker exec`, never on the host) on a cron schedule or on demand.
 */
export const taskRunStatusEnum = pgEnum("task_run_status", [
	"running",
	"success",
	"failed",
	/** The server was busy (lock policy "skip") or the app not running. */
	"skipped",
	"timeout",
	/** The kernel killed it for memory (container limit). */
	"oom",
	/** Ended by a signal (not the timeout, not OOM). */
	"killed",
]);

export const taskTriggerEnum = pgEnum("task_trigger", ["schedule", "manual"]);

/**
 * How the command is passed: `argv` = exec'd directly (no shell), `shell` =
 * `sh -c <script>` inside the container.
 */
export interface TaskCommand {
	argv?: string[];
	shell?: string;
}

export const appTasks = pgTable(
	"app_tasks",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		appId: uuid("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		/** Member who created it; scheduled runs act for the team. */
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		service: text("service").notNull(),
		command: jsonb("command").$type<TaskCommand>().notNull(),
		cron: text("cron").notNull(),
		timeoutSeconds: integer("timeout_seconds").notNull(),
		/** When the server is busy: "skip" or "queue"; null = TASK_LOCK_POLICY. */
		lockPolicy: text("lock_policy"),
		enabled: boolean("enabled").default(true).notNull(),
		lastRunAt: timestamp("last_run_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		index("app_tasks_app_id_idx").on(table.appId),
		index("app_tasks_team_id_idx").on(table.teamId),
	],
);

export const appTaskRuns = pgTable(
	"app_task_runs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		taskId: uuid("task_id")
			.notNull()
			.references(() => appTasks.id, { onDelete: "cascade" }),
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		appId: uuid("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		/**
		 * Job of the run (live log). Null for skipped runs and once job
		 * retention removed the job.
		 */
		deploymentId: uuid("deployment_id").references(() => deployments.id, {
			onDelete: "set null",
		}),
		trigger: taskTriggerEnum("trigger").notNull(),
		status: taskRunStatusEnum("status").default("running").notNull(),
		exitCode: integer("exit_code"),
		/** Tail of stdout+stderr (TASK_OUTPUT_MAX_BYTES). */
		output: text("output"),
		/** Why it failed or was skipped (source-language text or raw output). */
		error: text("error"),
		/** Coded form of the error (see `ErrorInfo` in #/libs/coded.ts). */
		errorCode: text("error_code"),
		errorParams: jsonb("error_params").$type<CodedParams>(),
		startedAt: timestamp("started_at").defaultNow().notNull(),
		finishedAt: timestamp("finished_at"),
		durationMs: integer("duration_ms"),
	},
	(table) => [
		index("app_task_runs_task_started_idx").on(table.taskId, table.startedAt),
		index("app_task_runs_app_id_idx").on(table.appId),
		index("app_task_runs_deployment_id_idx").on(table.deploymentId),
	],
);
