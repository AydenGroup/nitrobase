import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n.ts";
import {
	createDatabase,
	createManagedDatabase,
	createManagedUser,
	databaseSize,
	dropManaged,
	getDatabaseOverview,
	grantDatabase,
	linkDatabase,
	listAppDatabaseLinks,
	listDatabases,
	listDatabaseUsers,
	revealDatabaseConnection,
	runConsole,
	unlinkDatabase,
	upgradeDatabase,
} from "./databases.server";
import {
	ConsoleRunSchema,
	CreateDatabaseSchema,
	CreateManagedDatabaseSchema,
	CreateManagedUserSchema,
	DatabaseIdSchema,
	DropManagedSchema,
	GrantSchema,
	LinkDatabaseSchema,
	RevealDatabaseSchema,
	UnlinkDatabaseSchema,
	UpgradeDatabaseSchema,
} from "./schema";

/** Standalone databases (R3 M2). */

export const listDatabasesFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("database.view")])
	.handler(async ({ context }) => listDatabases(context.actor));

export const getDatabaseFn = createServerFn({ method: "GET" })
	.validator((id: string) => DatabaseIdSchema.parse(id))
	.middleware([requirePermission("database.view")])
	.handler(async ({ context, data }) =>
		getDatabaseOverview(context.actor, data),
	);

export const databaseSizeFn = createServerFn({ method: "GET" })
	.validator((id: string) => DatabaseIdSchema.parse(id))
	.middleware([requirePermission("database.view")])
	.handler(async ({ context, data }) => databaseSize(context.actor, data));

export const revealDatabaseFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => RevealDatabaseSchema.parse(data))
	.middleware([requirePermission("database.credentials.reveal")])
	.handler(async ({ context, data }) =>
		revealDatabaseConnection(context.actor, data),
	);

export const createDatabaseFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("database.manage")])
	.handler(async ({ context, data }) =>
		createDatabase(
			context.actor,
			CreateDatabaseSchema(context.i18n).parse(data),
		),
	);

export const upgradeDatabaseFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => UpgradeDatabaseSchema.parse(data))
	.middleware([requirePermission("database.manage")])
	.handler(async ({ context, data }) => upgradeDatabase(context.actor, data));

export const linkDatabaseFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => LinkDatabaseSchema.parse(data))
	.middleware([requirePermission("database.manage")])
	.handler(async ({ context, data }) => linkDatabase(context.actor, data));

export const unlinkDatabaseFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => UnlinkDatabaseSchema.parse(data))
	.middleware([requirePermission("database.manage")])
	.handler(async ({ context, data }) => unlinkDatabase(context.actor, data));

/** The databases an app is linked to (app page). */
export const listAppDatabaseLinksFn = createServerFn({ method: "GET" })
	.validator((appId: string) => z.guid().parse(appId))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		listAppDatabaseLinks(context.actor, data),
	);

/** Read-only runs need database.manage; write mode is re-checked (database.write). */
export const runConsoleFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => ConsoleRunSchema.parse(data))
	.middleware([requirePermission("database.manage")])
	.handler(async ({ context, data }) => runConsole(context.actor, data));

export const listDatabaseUsersFn = createServerFn({ method: "GET" })
	.validator((id: string) => DatabaseIdSchema.parse(id))
	.middleware([requirePermission("database.manage")])
	.handler(async ({ context, data }) => listDatabaseUsers(context.actor, data));

export const createManagedDatabaseFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CreateManagedDatabaseSchema.parse(data))
	.middleware([requirePermission("database.manage")])
	.handler(async ({ context, data }) => {
		await createManagedDatabase(context.actor, data);
		return { ok: true as const };
	});

export const createManagedUserFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CreateManagedUserSchema.parse(data))
	.middleware([requirePermission("database.manage")])
	.handler(async ({ context, data }) => createManagedUser(context.actor, data));

export const grantDatabaseFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => GrantSchema.parse(data))
	.middleware([requirePermission("database.manage")])
	.handler(async ({ context, data }) => {
		await grantDatabase(context.actor, data);
		return { ok: true as const };
	});

export const dropManagedFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => DropManagedSchema.parse(data))
	.middleware([requirePermission("database.manage")])
	.handler(async ({ context, data }) => {
		await dropManaged(context.actor, data);
		return { ok: true as const };
	});
