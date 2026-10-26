import { createServerFn } from "@tanstack/react-start";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { getExecutor } from "#/features/servers/servers.server.ts";
import {
	previewAppResources,
	serverCapacity,
	updateAppResources,
} from "./resources.server";
import { AppResourcesSchema } from "./schema";

/** Effective limits + overcommit check for unsaved resource edits. */
export const previewAppResourcesFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => AppResourcesSchema.parse(data))
	.middleware([requirePermission("app.resources.manage")])
	.handler(async ({ context, data }) =>
		previewAppResources(context.actor, data, async (server) => {
			const executor = await getExecutor(server);
			try {
				return await serverCapacity(executor);
			} finally {
				executor.close();
			}
		}),
	);

/** Save resource limit overrides (applied by the next deploy). */
export const updateAppResourcesFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => AppResourcesSchema.parse(data))
	.middleware([requirePermission("app.resources.manage")])
	.handler(async ({ context, data }) => {
		await updateAppResources(context.actor, data);
		return { ok: true as const };
	});
