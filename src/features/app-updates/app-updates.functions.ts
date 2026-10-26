import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import {
	autoUpdateWindow,
	checkAppNow,
	listAppUpdates,
	setUpdatePolicy,
} from "./app-updates.server";
import {
	BulkUpdateSchema,
	UpdateAppSchema,
	UpdatePolicySchema,
} from "./schema";
import {
	getUpdateBatch,
	startAppUpdate,
	startUpdateBatch,
} from "./update-jobs.server";

/** Update state of every app of the team (badges, lists, dashboard). */
export const listAppUpdatesFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("app.view")])
	.handler(async ({ context }) => listAppUpdates(context.actor));

/** "Check for updates": asks the app's source now (may run git on its server). */
export const checkAppUpdateFn = createServerFn({ method: "POST" })
	.validator((appId: string) => z.guid().parse(appId))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) => checkAppNow(context.actor, data));

/** One-click update: backup first (default), automatic rollback on failure. */
export const updateAppFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => UpdateAppSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) =>
		startAppUpdate(context.actor, { ...data, trigger: "manual" }),
	);

export const bulkUpdateAppsFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => BulkUpdateSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) => startUpdateBatch(context.actor, data));

export const getUpdateBatchFn = createServerFn({ method: "GET" })
	.validator((id: string) => z.guid().parse(id))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) => getUpdateBatch(context.actor, data));

export const setUpdatePolicyFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => UpdatePolicySchema.parse(data))
	.middleware([requirePermission("app.update_policy.manage")])
	.handler(async ({ context, data }) => setUpdatePolicy(context.actor, data));

/** Maintenance window of automatic updates (shown next to policies). */
export const getAutoUpdateWindowFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("app.view")])
	.handler(async () => autoUpdateWindow());
