import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { getInstanceUpdate } from "./release.server";
import { StartUpgradeSchema } from "./schema";
import { getUpgradeOverview, startPanelUpgrade } from "./upgrade.server";

/** Settings → Instance: version, latest release, whether Upgrade can run. */
export const getUpgradeOverviewFn = createServerFn({ method: "GET" })
	.validator((data: unknown) =>
		z.object({ refresh: z.boolean().optional() }).parse(data ?? {}),
	)
	.middleware([requirePermission("instance.manage")])
	.handler(async ({ context, data }) =>
		getUpgradeOverview(context.actor, data),
	);

/** Dashboard banner: the cached release check only (no host inspection). */
export const getInstanceUpdateFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("instance.manage")])
	.handler(async () => getInstanceUpdate());

/** Upgrade Nitrobase: self-backup, pull, updater (audited, instance admins). */
export const startPanelUpgradeFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => StartUpgradeSchema.parse(data))
	.middleware([requirePermission("instance.manage")])
	.handler(async ({ context, data }) => startPanelUpgrade(context.actor, data));
