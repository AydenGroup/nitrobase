import { createServerFn } from "@tanstack/react-start";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { listAuditEvents } from "./audit.server";
import { AuditListSchema } from "./schema";

export const listAuditEventsFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => AuditListSchema.parse(data ?? {}))
	.middleware([requirePermission("team.view")])
	.handler(async ({ context, data }) => listAuditEvents(context.actor, data));
