import { createServerFn } from "@tanstack/react-start";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n.ts";
import {
	createConnection,
	deleteConnection,
	listConnections,
	testConnection,
	updateConnection,
} from "./connections.server";
import {
	cloudExportOptions,
	previewCloudExport,
	startCloudExport,
} from "./export.server";
import {
	listAppSyncs,
	previewCloudImport,
	startCloudImport,
} from "./import.server";
import {
	AppSyncsSchema,
	CloudConnectionIdSchema,
	CloudConnectionInputSchema,
	CloudExportOptionsSchema,
	CloudExportPreflightSchema,
	CloudExportSchema,
	CloudImportSchema,
	CloudPreflightSchema,
	UpdateCloudConnectionSchema,
} from "./schema";

// Connections (credentials never leave the server: secrets come back masked)

export const listCloudConnectionsFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("cloud_connection.view")])
	.handler(async ({ context }) => listConnections(context.actor));

export const createCloudConnectionFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("cloud_connection.manage")])
	.handler(async ({ context, data }) =>
		createConnection(
			context.actor,
			CloudConnectionInputSchema(context.i18n).parse(data),
		),
	);

export const updateCloudConnectionFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("cloud_connection.manage")])
	.handler(async ({ context, data }) => {
		await updateConnection(
			context.actor,
			UpdateCloudConnectionSchema(context.i18n).parse(data),
		);
		return { success: true };
	});

export const deleteCloudConnectionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CloudConnectionIdSchema.parse(data))
	.middleware([requirePermission("cloud_connection.manage")])
	.handler(async ({ context, data }) => {
		await deleteConnection(context.actor, data.id);
		return { success: true };
	});

export const testCloudConnectionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CloudConnectionIdSchema.parse(data))
	.middleware([requirePermission("cloud_connection.manage")])
	.handler(async ({ context, data }) => testConnection(context.actor, data.id));

// Import (a new app from a cloud project)

/** Read-only, but it reaches the cloud with the stored credentials. */
export const previewCloudImportFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CloudPreflightSchema.parse(data))
	.middleware([requirePermission("app.sync")])
	.handler(async ({ context, data }) =>
		previewCloudImport(context.actor, data),
	);

export const startCloudImportFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CloudImportSchema.parse(data))
	.middleware([requirePermission("app.sync")])
	.handler(async ({ context, data }) => startCloudImport(context.actor, data));

export const listAppSyncsFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => AppSyncsSchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		listAppSyncs(context.actor, data.appId),
	);

// Export (an app into an empty cloud project)

/** What the export modal can offer (e.g. the app's projects). */
export const cloudExportOptionsFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CloudExportOptionsSchema.parse(data))
	.middleware([requirePermission("app.sync")])
	.handler(async ({ context, data }) =>
		cloudExportOptions(context.actor, data),
	);

/** Read-only: checks the cloud project is empty and what would be copied. */
export const previewCloudExportFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CloudExportPreflightSchema.parse(data))
	.middleware([requirePermission("app.sync")])
	.handler(async ({ context, data }) =>
		previewCloudExport(context.actor, data),
	);

export const startCloudExportFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CloudExportSchema.parse(data))
	.middleware([requirePermission("app.sync")])
	.handler(async ({ context, data }) => startCloudExport(context.actor, data));
