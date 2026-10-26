import { getConfig } from "#/config/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { asTerms } from "#/libs/coded.ts";
import { audit } from "#/server/services/audit.ts";
import {
	assertOwnerSql,
	dropFunctionSql,
	formatPsqlError,
	functionDefinitionQuery,
	listFunctionsQuery,
	listSchemasQuery,
	newFunctionSql,
	psqlCommand,
} from "#/server/services/supabase/sql.ts";
import { AppError } from "#/utils/error.ts";
import type {
	DbFunctionSummary,
	DbSchemaSummary,
	HttpResult,
	SqlResult,
} from "./schema";
import { analyzeSqlRisk, maskSql } from "./sql-guard";
import {
	gatewayRequest,
	requireDeployed,
	type SupabaseContext,
	supabaseContext,
	withExecutor,
} from "./supabase.server";

/**
 * Database Functions run SQL as the template's database superuser inside
 * the db container. Browsing (schemas, functions, definitions) needs
 * `app.view`; running SQL, dropping and the RPC runner need `app.database`
 * (owner, admin, developer; see `supabase.functions.ts`). Every mutation is
 * audited, including statements refused before they run.
 */

async function dbContext(actor: Actor, appId: string) {
	const ctx = await supabaseContext(actor, appId, "db-functions");
	requireDeployed(ctx, ctx.config.db_service);
	return ctx;
}

function target(ctx: SupabaseContext) {
	return {
		container: ctx.container(ctx.config.db_service),
		user: ctx.config.db_user,
		database: ctx.config.db_name,
		timeoutMs: getConfig().SUPABASE_SQL_TIMEOUT_MS,
	};
}

/** Run SQL; returns stdout or throws SQL_ERROR with psql's message. */
async function runSql(
	ctx: SupabaseContext,
	sql: string,
	tuples: boolean,
): Promise<{ ok: boolean; stdout: string; error: string | null }> {
	const result = await withExecutor(ctx, (executor) =>
		executor.exec(psqlCommand(target(ctx), tuples), {
			input: sql,
			timeoutMs:
				getConfig().SUPABASE_SQL_TIMEOUT_MS +
				getConfig().SUPABASE_EXEC_SLACK_MS,
		}),
	);
	if (result.exitCode !== 0) {
		return {
			ok: false,
			stdout: result.stdout,
			error: formatPsqlError(result.stderr || result.stdout),
		};
	}
	return { ok: true, stdout: result.stdout, error: null };
}

async function queryJson<T>(ctx: SupabaseContext, sql: string): Promise<T> {
	const result = await runSql(ctx, sql, true);
	if (!result.ok) {
		throw new AppError("SQL_ERROR", { message: result.error ?? "" });
	}
	try {
		return JSON.parse(result.stdout.trim() || "null") as T;
	} catch {
		throw new AppError("SQL_OUTPUT_UNEXPECTED");
	}
}

/** Template-managed schemas can be browsed but not changed from the UI. */
function assertWritableSchema(ctx: SupabaseContext, schema: string): void {
	if (ctx.config.db_readonly_schemas.includes(schema)) {
		throw new AppError("SQL_SCHEMA_READ_ONLY", { schema });
	}
}

export async function listDbSchemas(
	actor: Actor,
	appId: string,
): Promise<DbSchemaSummary[]> {
	const ctx = await dbContext(actor, appId);
	const names = await queryJson<string[]>(ctx, listSchemasQuery());
	return names.map((name) => ({
		name,
		readOnly: ctx.config.db_readonly_schemas.includes(name),
	}));
}

export async function listDbFunctions(
	actor: Actor,
	appId: string,
	schema: string,
): Promise<DbFunctionSummary[]> {
	const ctx = await dbContext(actor, appId);
	const rows = await queryJson<DbFunctionSummary[]>(
		ctx,
		listFunctionsQuery(schema),
	);
	return rows.map((row) => ({ ...row, oid: Number(row.oid) }));
}

export async function getDbFunctionDefinition(
	actor: Actor,
	appId: string,
	schema: string,
	oid: number,
): Promise<string> {
	const ctx = await dbContext(actor, appId);
	const result = await runSql(ctx, functionDefinitionQuery(schema, oid), true);
	if (!result.ok)
		throw new AppError("SQL_ERROR", { message: result.error ?? "" });
	if (!result.stdout.trim()) {
		throw new AppError("FUNCTION_NOT_FOUND", { name: String(oid) });
	}
	return result.stdout.replace(/\n$/, "");
}

/** Starter SQL for the "New function" editor. */
export async function getNewDbFunctionSql(
	actor: Actor,
	appId: string,
	schema: string,
): Promise<string> {
	const ctx = await dbContext(actor, appId);
	assertWritableSchema(ctx, schema);
	return newFunctionSql(schema);
}

/**
 * Apply owner SQL (CREATE OR REPLACE FUNCTION …). Errors are returned, not
 * thrown, so the editor can show them inline. Statements that drop a schema,
 * change roles, run a program or change a schema the template manages run
 * only with `acknowledgeRisk` (see `analyzeSqlRisk`). The audit entry keeps
 * the statement with its literals hidden; refused statements are audited too.
 */
export async function applyDbSql(
	actor: Actor,
	appId: string,
	sql: string,
	acknowledgeRisk = false,
): Promise<SqlResult> {
	const ctx = await dbContext(actor, appId);
	const bytes = Buffer.byteLength(sql, "utf8");
	const statement = maskSql(sql.slice(0, getConfig().SUPABASE_SQL_AUDIT_CHARS));
	const record = (meta: Record<string, unknown>) =>
		audit({
			actor,
			action: "supabase.sql.apply",
			targetType: "app",
			targetId: ctx.app.id,
			meta: { ...meta, bytes, statement },
		});
	try {
		assertOwnerSql(sql, getConfig().SUPABASE_SQL_MAX_BYTES);
	} catch (error) {
		if (error instanceof AppError) record({ ok: false, blocked: error.code });
		throw error;
	}
	const risks = analyzeSqlRisk(sql, ctx.config.db_readonly_schemas);
	if (risks.length > 0 && !acknowledgeRisk) {
		record({ ok: false, blocked: "SQL_RISK_NOT_ACKNOWLEDGED", risks });
		throw new AppError("SQL_RISK_NOT_ACKNOWLEDGED", {
			risks: asTerms("sql_risk", risks),
		});
	}
	const result = await runSql(ctx, sql, false);
	record({
		ok: result.ok,
		...(risks.length > 0 ? { risks, acknowledged: true } : {}),
	});
	return { ok: result.ok, output: result.stdout, error: result.error };
}

export async function dropDbFunction(
	actor: Actor,
	appId: string,
	schema: string,
	oid: number,
): Promise<SqlResult> {
	const ctx = await dbContext(actor, appId);
	assertWritableSchema(ctx, schema);
	const result = await runSql(ctx, dropFunctionSql(schema, oid), false);
	audit({
		actor,
		action: "supabase.function.drop",
		targetType: "app",
		targetId: ctx.app.id,
		meta: { schema, oid, ok: result.ok },
	});
	return { ok: result.ok, output: result.stdout, error: result.error };
}

/** `POST /rest/v1/rpc/<name>` through the gateway (PostgREST). */
export async function runRpc(
	actor: Actor,
	input: {
		appId: string;
		schema: string;
		name: string;
		args: string;
		key: "anon" | "service";
	},
): Promise<HttpResult> {
	const ctx = await supabaseContext(actor, input.appId, "db-functions");
	let args: unknown;
	try {
		args = JSON.parse(input.args || "{}");
	} catch {
		throw new AppError("RPC_ARGS_NOT_JSON");
	}
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		throw new AppError("RPC_ARGS_NOT_OBJECT");
	}
	audit({
		actor,
		action: "supabase.rpc.run",
		targetType: "app",
		targetId: ctx.app.id,
		meta: { schema: input.schema, name: input.name, key: input.key },
	});
	return gatewayRequest(ctx, {
		path: `/rest/v1/rpc/${input.name}`,
		method: "POST",
		key: input.key,
		body: JSON.stringify(args),
		// PostgREST picks the schema from Content-Profile (must be exposed).
		headers:
			input.schema === "public" ? {} : { "Content-Profile": input.schema },
	});
}
