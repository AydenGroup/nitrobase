import { randomBytes } from "node:crypto";
import { getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { appLocation } from "#/features/apps/apps.server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { withAppServerLock } from "#/features/deployments/deployments.server.ts";
import { clip } from "#/libs/format.ts";
import { getEdgeFunctionStarter } from "#/plugins/supabase/starters.ts";
import { composeServiceCommand } from "#/server/services/apps/commands.ts";
import { audit } from "#/server/services/audit.ts";
import type { Executor } from "#/server/services/executor.ts";
import {
	assertFunctionFiles,
	assertFunctionName,
	assertNewSharedFolderName,
	assertSharedFolderName,
	buildTar,
	cleanupStagingCommand,
	deleteFunctionCommand,
	deployFunctionScript,
	type FolderEntry,
	type FunctionFile,
	listFoldersCommand,
	listFunctionsCommand,
	NOT_RUNNING_EXIT,
	parseFolderList,
	parseFunctionList,
	parseTar,
	readFunctionCommand,
	STAGING_PREFIX,
} from "#/server/services/supabase/edge-functions.ts";
import { AppError } from "#/utils/error.ts";
import type {
	EdgeFunctionSource,
	EdgeFunctionSummary,
	HttpResult,
} from "./schema";
import {
	gatewayRequest,
	requireDeployed,
	type SupabaseContext,
	supabaseContext,
	withExecutor,
} from "./supabase.server";

function limits() {
	const config = getConfig();
	return {
		maxFiles: config.SUPABASE_FUNCTION_MAX_FILES,
		maxBytes: config.SUPABASE_FUNCTION_MAX_BYTES,
	};
}

async function functionsContext(actor: Actor, appId: string) {
	const ctx = await supabaseContext(actor, appId, "edge-functions");
	requireDeployed(ctx, ctx.config.functions_service);
	return {
		ctx,
		container: ctx.container(ctx.config.functions_service),
		dir: ctx.config.functions_dir,
		reserved: ctx.config.functions_reserved,
	};
}

function check(
	result: { exitCode: number; stderr: string; stdout: string },
	service: string,
): string {
	if (result.exitCode === NOT_RUNNING_EXIT) {
		throw new AppError("SERVICE_NOT_RUNNING", { service });
	}
	if (result.exitCode !== 0) {
		throw new AppError("FUNCTION_COMMAND_FAILED", {
			detail: clip(
				(result.stderr || result.stdout).trim(),
				TEXT_LIMITS.errorDetail,
			),
		});
	}
	return result.stdout;
}

function folderOptions(ctx: SupabaseContext) {
	return {
		reserved: ctx.config.functions_reserved,
		entrypointsKnown: ctx.config.functions_entrypoints.length > 0,
	};
}

/** Every top-level folder of the functions directory, classified. */
async function listFolders(
	ctx: SupabaseContext,
	executor: Executor,
	container: string,
	dir: string,
): Promise<FolderEntry[]> {
	const output = check(
		await executor.exec(
			listFoldersCommand(container, dir, ctx.config.functions_entrypoints),
		),
		ctx.config.functions_service,
	);
	return parseFolderList(output, folderOptions(ctx));
}

/**
 * Re-classify `name` on the server right now: only a real shared folder may be
 * read, saved over or deleted through the shared path (never a function or
 * `main`).
 */
async function requireSharedFolder(
	ctx: SupabaseContext,
	executor: Executor,
	container: string,
	dir: string,
	name: string,
): Promise<FolderEntry> {
	const entry = (await listFolders(ctx, executor, container, dir)).find(
		(folder) => folder.name === name,
	);
	if (!entry) throw new AppError("FUNCTION_SHARED_NOT_FOUND", { name });
	if (entry.kind !== "shared") {
		throw new AppError("FUNCTION_NOT_SHARED", { name });
	}
	return entry;
}

export async function listEdgeFunctions(
	actor: Actor,
	appId: string,
): Promise<EdgeFunctionSummary[]> {
	const { ctx, container, dir } = await functionsContext(actor, appId);
	const folders = await withExecutor(ctx, (executor) =>
		listFolders(ctx, executor, container, dir),
	);
	return folders
		.filter((folder) => folder.kind === "function")
		.map(({ name, updatedAt }) => ({ name, updatedAt }));
}

export async function listSharedFolders(
	actor: Actor,
	appId: string,
): Promise<EdgeFunctionSummary[]> {
	const { ctx, container, dir } = await functionsContext(actor, appId);
	const folders = await withExecutor(ctx, (executor) =>
		listFolders(ctx, executor, container, dir),
	);
	return folders
		.filter((folder) => folder.kind === "shared")
		.map(({ name, updatedAt }) => ({ name, updatedAt }));
}

async function readSource(
	executor: Executor,
	container: string,
	dir: string,
	name: string,
	options: { shared?: boolean } = {},
): Promise<EdgeFunctionSource | null> {
	const result = await executor.exec(
		readFunctionCommand(container, dir, name, options),
	);
	const encoded = result.stdout.replace(/\s+/g, "");
	if (!encoded) return null;
	const { files, skipped } = parseTar(Buffer.from(encoded, "base64"), limits());
	return {
		name,
		files: files.sort((a, b) => a.path.localeCompare(b.path)),
		skipped,
	};
}

export async function getEdgeFunction(
	actor: Actor,
	appId: string,
	name: string,
): Promise<EdgeFunctionSource> {
	const { ctx, container, dir, reserved } = await functionsContext(
		actor,
		appId,
	);
	assertFunctionName(name, reserved);
	const source = await withExecutor(ctx, (executor) =>
		readSource(executor, container, dir, name),
	);
	if (!source) throw new AppError("FUNCTION_NOT_FOUND", { name });
	return source;
}

/**
 * Write the function through the container (tar via `docker cp`, swap via
 * `docker exec`), then restart the edge runtime so it serves the new code.
 */
async function deploy(
	ctx: SupabaseContext,
	executor: Executor,
	container: string,
	dir: string,
	name: string,
	files: FunctionFile[],
	options: { shared?: boolean } = {},
): Promise<void> {
	const staging = `${STAGING_PREFIX}${name}-${randomBytes(4).toString("hex")}`;
	const tar = buildTar(staging, files);
	const result = await executor.exec(
		deployFunctionScript(container, dir, name, staging, options),
		{ input: tar },
	);
	if (result.exitCode !== 0) {
		await executor.exec(cleanupStagingCommand(container, dir));
	}
	check(result, ctx.config.functions_service);
	const restart = await executor.exec(
		composeServiceCommand(
			appLocation(ctx.app),
			"restart",
			ctx.config.functions_service,
		),
	);
	check(restart, ctx.config.functions_service);
}

export async function saveEdgeFunction(
	actor: Actor,
	input: { appId: string; name: string; files: FunctionFile[] },
	options: { create?: boolean } = {},
): Promise<EdgeFunctionSummary> {
	const { ctx, container, dir, reserved } = await functionsContext(
		actor,
		input.appId,
	);
	assertFunctionName(input.name, reserved);
	assertFunctionFiles(input.files, limits());
	await withAppServerLock(ctx.app, () =>
		withExecutor(ctx, async (executor) => {
			if (options.create) {
				const existing = parseFunctionList(
					check(
						await executor.exec(listFunctionsCommand(container, dir)),
						ctx.config.functions_service,
					),
					[],
				);
				if (existing.some((entry) => entry.name === input.name)) {
					throw new AppError("FUNCTION_EXISTS", { name: input.name });
				}
			}
			await deploy(ctx, executor, container, dir, input.name, input.files);
		}),
	);
	audit({
		actor,
		action: options.create
			? "supabase.function.create"
			: "supabase.function.deploy",
		targetType: "app",
		targetId: ctx.app.id,
		meta: { name: input.name, files: input.files.map((file) => file.path) },
	});
	return { name: input.name, updatedAt: new Date().toISOString() };
}

export async function createEdgeFunction(
	actor: Actor,
	input: { appId: string; name: string; starter: string },
): Promise<EdgeFunctionSummary> {
	const starter = getEdgeFunctionStarter(input.starter);
	if (!starter) {
		throw new AppError("FUNCTION_STARTER_UNKNOWN", { starter: input.starter });
	}
	return saveEdgeFunction(
		actor,
		{ appId: input.appId, name: input.name, files: starter.files },
		{ create: true },
	);
}

export async function deleteEdgeFunction(
	actor: Actor,
	appId: string,
	name: string,
): Promise<void> {
	const { ctx, container, dir, reserved } = await functionsContext(
		actor,
		appId,
	);
	assertFunctionName(name, reserved);
	await withAppServerLock(ctx.app, () =>
		withExecutor(ctx, async (executor) =>
			check(
				await executor.exec(deleteFunctionCommand(container, dir, name)),
				ctx.config.functions_service,
			),
		),
	);
	audit({
		actor,
		action: "supabase.function.delete",
		targetType: "app",
		targetId: ctx.app.id,
		meta: { name },
	});
}

export async function invokeEdgeFunction(
	actor: Actor,
	input: {
		appId: string;
		name: string;
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
		body?: string;
		key: "anon" | "service";
	},
): Promise<HttpResult> {
	const { ctx, reserved } = await functionsContext(actor, input.appId);
	assertFunctionName(input.name, reserved);
	audit({
		actor,
		action: "supabase.function.invoke",
		targetType: "app",
		targetId: ctx.app.id,
		meta: { name: input.name, method: input.method, key: input.key },
	});
	return gatewayRequest(ctx, {
		path: `/functions/v1/${input.name}`,
		method: input.method,
		key: input.key,
		body: input.body,
	});
}

// Shared code folders (`_shared`, `lib`...): imported by functions, never served.

export async function getSharedFolder(
	actor: Actor,
	appId: string,
	name: string,
): Promise<EdgeFunctionSource> {
	const { ctx, container, dir } = await functionsContext(actor, appId);
	assertSharedFolderName(name, ctx.config.functions_reserved);
	const source = await withExecutor(ctx, async (executor) => {
		await requireSharedFolder(ctx, executor, container, dir, name);
		return readSource(executor, container, dir, name, { shared: true });
	});
	if (!source) throw new AppError("FUNCTION_SHARED_NOT_FOUND", { name });
	return source;
}

export async function saveSharedFolder(
	actor: Actor,
	input: { appId: string; name: string; files: FunctionFile[] },
	options: { create?: boolean } = {},
): Promise<EdgeFunctionSummary> {
	const { ctx, container, dir } = await functionsContext(actor, input.appId);
	if (options.create) {
		assertNewSharedFolderName(input.name, ctx.config.functions_reserved);
	} else {
		assertSharedFolderName(input.name, ctx.config.functions_reserved);
	}
	assertFunctionFiles(input.files, limits());
	await withAppServerLock(ctx.app, () =>
		withExecutor(ctx, async (executor) => {
			if (options.create) {
				const existing = await listFolders(ctx, executor, container, dir);
				if (existing.some((folder) => folder.name === input.name)) {
					throw new AppError("FUNCTION_EXISTS", { name: input.name });
				}
			} else {
				await requireSharedFolder(ctx, executor, container, dir, input.name);
			}
			await deploy(ctx, executor, container, dir, input.name, input.files, {
				shared: true,
			});
		}),
	);
	audit({
		actor,
		action: options.create
			? "supabase.shared.create"
			: "supabase.shared.deploy",
		targetType: "app",
		targetId: ctx.app.id,
		meta: { name: input.name, files: input.files.map((file) => file.path) },
	});
	return { name: input.name, updatedAt: new Date().toISOString() };
}

export async function deleteSharedFolder(
	actor: Actor,
	appId: string,
	name: string,
): Promise<void> {
	const { ctx, container, dir } = await functionsContext(actor, appId);
	assertSharedFolderName(name, ctx.config.functions_reserved);
	await withAppServerLock(ctx.app, () =>
		withExecutor(ctx, async (executor) => {
			await requireSharedFolder(ctx, executor, container, dir, name);
			check(
				await executor.exec(
					deleteFunctionCommand(container, dir, name, { shared: true }),
				),
				ctx.config.functions_service,
			);
		}),
	);
	audit({
		actor,
		action: "supabase.shared.delete",
		targetType: "app",
		targetId: ctx.app.id,
		meta: { name },
	});
}
