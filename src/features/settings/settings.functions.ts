import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { SettingKeySchema } from "#/config/settings.ts";
import { authMiddleware } from "#/features/auth/authMiddleware";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { startBackgroundWork } from "#/server/background.ts";
import { audit } from "#/server/services/audit.ts";
import { applyPanelDomain, panelEnvHints } from "./instance.server";
import { instanceState, resumeInstanceHere } from "./instance-identity.server";
import { listSettings, setSetting } from "./settings.server";

export const listSettingsFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("instance.manage")])
	.handler(async () => listSettings());

export const updateSettingFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ key: SettingKeySchema, value: z.string().nullable() })
			.parse(data),
	)
	.middleware([requirePermission("instance.manage")])
	.handler(async ({ context, data }) => {
		await setSetting(context.actor, data.key, data.value);
		return { success: true };
	});

/** Env lines shown under the panel domain (port from the config). */
export const getPanelEnvHintsFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => z.object({ domain: z.string() }).parse(data))
	.middleware([requirePermission("instance.manage")])
	.handler(async ({ data }) => panelEnvHints(data.domain));

export const applyPanelDomainFn = createServerFn({ method: "POST" })
	.middleware([requirePermission("instance.manage")])
	.handler(async ({ context }) => applyPanelDomain(context.actor));

/**
 * Account-level: whether this installation is paused (restored or cloned
 * database, see instance-state.ts). Every member sees the banner.
 */
export const getInstanceStateFn = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async () => instanceState());

/** "This database was moved — resume here": rebind and start background work. */
export const resumeInstanceFn = createServerFn({ method: "POST" })
	.middleware([requirePermission("instance.manage")])
	.handler(async ({ context }) => {
		await resumeInstanceHere();
		startBackgroundWork();
		audit({ actor: context.actor, action: "settings.instance_resume" });
		return instanceState();
	});
