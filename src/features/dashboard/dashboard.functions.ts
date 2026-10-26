import { createServerFn } from "@tanstack/react-start";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { getDashboard } from "./dashboard.server";

export const getDashboardFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("server.view")])
	.handler(async ({ context }) => getDashboard(context.actor));
