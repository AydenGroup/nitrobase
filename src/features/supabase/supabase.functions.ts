import { createServerFn } from "@tanstack/react-start";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import {
	applyDbSql,
	dropDbFunction,
	getDbFunctionDefinition,
	getNewDbFunctionSql,
	listDbFunctions,
	listDbSchemas,
	runRpc,
} from "./db-functions.server";
import {
	createEdgeFunction,
	deleteEdgeFunction,
	deleteSharedFolder,
	getEdgeFunction,
	getSharedFolder,
	invokeEdgeFunction,
	listEdgeFunctions,
	listSharedFolders,
	saveEdgeFunction,
	saveSharedFolder,
} from "./edge-functions.server";
import {
	AppOnlySchema,
	CreateFunctionSchema,
	DbFunctionRefSchema,
	DbSchemaQuerySchema,
	FunctionRefSchema,
	InvokeFunctionSchema,
	RunRpcSchema,
	RunSqlSchema,
	SaveFunctionSchema,
	SaveSharedFolderSchema,
	SharedFolderRefSchema,
} from "./schema";
import { startStorageRepair } from "./storage-metadata.server";
import { getSupabaseOverview } from "./supabase.server";

// Overview / API keys (service_role is revealed via revealCredentialFn).

export const getSupabaseOverviewFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => AppOnlySchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		getSupabaseOverview(context.actor, data.appId),
	);

/** Rebuild missing storage file attributes from the database (a job). */
export const repairStorageMetadataFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => AppOnlySchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) =>
		startStorageRepair(context.actor, data.appId),
	);

// Edge Functions

export const listEdgeFunctionsFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => AppOnlySchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		listEdgeFunctions(context.actor, data.appId),
	);

export const getEdgeFunctionFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => FunctionRefSchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		getEdgeFunction(context.actor, data.appId, data.name),
	);

export const createEdgeFunctionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CreateFunctionSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) =>
		createEdgeFunction(context.actor, data),
	);

/** Deploy = write files through the container, then reload the runtime. */
export const saveEdgeFunctionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => SaveFunctionSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) => saveEdgeFunction(context.actor, data));

export const deleteEdgeFunctionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => FunctionRefSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) => {
		await deleteEdgeFunction(context.actor, data.appId, data.name);
		return { success: true };
	});

export const invokeEdgeFunctionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => InvokeFunctionSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) =>
		invokeEdgeFunction(context.actor, data),
	);

// Shared code folders (`_shared`...) next to the functions

export const listSharedFoldersFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => AppOnlySchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		listSharedFolders(context.actor, data.appId),
	);

export const getSharedFolderFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => SharedFolderRefSchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		getSharedFolder(context.actor, data.appId, data.name),
	);

/** Create (`create: true`) or deploy a shared folder; restarts the runtime. */
export const saveSharedFolderFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => SaveSharedFolderSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) =>
		saveSharedFolder(
			context.actor,
			{ appId: data.appId, name: data.name, files: data.files },
			{ create: data.create },
		),
	);

export const deleteSharedFolderFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => SharedFolderRefSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) => {
		await deleteSharedFolder(context.actor, data.appId, data.name);
		return { success: true };
	});

// Database Functions (SQL runs as the database superuser; owner-only, audited)

export const listDbSchemasFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => AppOnlySchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		listDbSchemas(context.actor, data.appId),
	);

export const listDbFunctionsFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => DbSchemaQuerySchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		listDbFunctions(context.actor, data.appId, data.schema),
	);

export const getDbFunctionDefinitionFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => DbFunctionRefSchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		getDbFunctionDefinition(context.actor, data.appId, data.schema, data.oid),
	);

export const getNewDbFunctionSqlFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => DbSchemaQuerySchema.parse(data))
	.middleware([requirePermission("app.database")])
	.handler(async ({ context, data }) =>
		getNewDbFunctionSql(context.actor, data.appId, data.schema),
	);

export const applyDbSqlFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => RunSqlSchema.parse(data))
	.middleware([requirePermission("app.database")])
	.handler(async ({ context, data }) =>
		applyDbSql(context.actor, data.appId, data.sql, data.acknowledgeRisk),
	);

export const dropDbFunctionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => DbFunctionRefSchema.parse(data))
	.middleware([requirePermission("app.database")])
	.handler(async ({ context, data }) =>
		dropDbFunction(context.actor, data.appId, data.schema, data.oid),
	);

export const runRpcFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => RunRpcSchema.parse(data))
	.middleware([requirePermission("app.database")])
	.handler(async ({ context, data }) => runRpc(context.actor, data));
