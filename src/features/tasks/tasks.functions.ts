import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n.ts";
import { TaskInputSchema, TaskRefSchema, TaskUpdateSchema } from "./schema";
import {
	createTask,
	deleteTask,
	listTaskRuns,
	listTasks,
	runTaskNow,
	taskSettings,
	updateTask,
} from "./tasks.server";

export const listTasksFn = createServerFn({ method: "GET" })
	.validator((appId: string) => z.guid().parse(appId))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) => ({
		tasks: await listTasks(context.actor, data),
		settings: taskSettings(),
	}));

export const listTaskRunsFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => TaskRefSchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) => listTaskRuns(context.actor, data));

export const createTaskFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("app.tasks.manage")])
	.handler(async ({ context, data }) =>
		createTask(context.actor, TaskInputSchema(context.i18n).parse(data)),
	);

export const updateTaskFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("app.tasks.manage")])
	.handler(async ({ context, data }) =>
		updateTask(context.actor, TaskUpdateSchema(context.i18n).parse(data)),
	);

export const deleteTaskFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => TaskRefSchema.parse(data))
	.middleware([requirePermission("app.tasks.manage")])
	.handler(async ({ context, data }) => {
		await deleteTask(context.actor, data);
		return { ok: true as const };
	});

/** Start a manual run now (a job; SERVER_BUSY while another job runs). */
export const runTaskNowFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => TaskRefSchema.parse(data))
	.middleware([requirePermission("app.tasks.manage")])
	.handler(async ({ context, data }) => runTaskNow(context.actor, data));
