import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const state = {
		managed: ["auth", "storage"] as string[],
		auditChars: 2000,
		result: { exitCode: 0, stdout: "", stderr: "" },
		inputs: [] as string[],
	};
	const executor = {
		exec: async (_command: string, options?: { input?: string }) => {
			state.inputs.push(options?.input ?? "");
			return state.result;
		},
	};
	return { state, executor, audit: vi.fn() };
});

vi.mock("#/config/server.ts", () => ({
	getConfig: () => ({
		SUPABASE_SQL_TIMEOUT_MS: 30_000,
		SUPABASE_EXEC_SLACK_MS: 5_000,
		SUPABASE_SQL_MAX_BYTES: 262_144,
		SUPABASE_SQL_AUDIT_CHARS: h.state.auditChars,
	}),
}));
vi.mock("#/server/services/audit.ts", () => ({ audit: h.audit }));
vi.mock("./supabase.server", () => ({
	gatewayRequest: vi.fn(),
	requireDeployed: vi.fn(),
	supabaseContext: async () => ({
		app: { id: "app-1" },
		config: {
			db_service: "db",
			db_user: "supabase_admin",
			db_name: "postgres",
			db_readonly_schemas: h.state.managed,
		},
		container: (service: string) => `supabase-0123abcd-${service}`,
	}),
	withExecutor: async (_ctx: unknown, fn: (executor: unknown) => unknown) =>
		fn(h.executor),
}));

const { applyDbSql } = await import("./db-functions.server");

const actor = {} as never;
const auditMeta = () => h.audit.mock.calls.at(-1)?.[0].meta;

beforeEach(() => {
	h.audit.mockClear();
	h.state.managed = ["auth", "storage"];
	h.state.auditChars = 2000;
	h.state.result = { exitCode: 0, stdout: "", stderr: "" };
	h.state.inputs = [];
});

describe("applyDbSql: audit trail (G-26)", () => {
	it("records the statement with its literals hidden, and its size", async () => {
		const sql = "select 'p4ssw0rd' as x;";
		const result = await applyDbSql(actor, "app-1", sql);
		expect(result.ok).toBe(true);
		expect(h.audit).toHaveBeenCalledTimes(1);
		expect(h.audit.mock.calls[0][0]).toMatchObject({
			action: "supabase.sql.apply",
			targetType: "app",
			targetId: "app-1",
		});
		expect(auditMeta()).toEqual({
			ok: true,
			bytes: Buffer.byteLength(sql, "utf8"),
			statement: "select '…' as x;",
		});
	});

	it("records a statement that psql rejected as not ok", async () => {
		h.state.result = { exitCode: 1, stdout: "", stderr: "ERROR: syntax error" };
		const result = await applyDbSql(actor, "app-1", "selec 1");
		expect(result.ok).toBe(false);
		expect(auditMeta()).toEqual({ ok: false, bytes: 7, statement: "selec 1" });
	});

	it("records a refused psql meta-command as blocked, and never runs it", async () => {
		await expect(
			applyDbSql(actor, "app-1", "\\! echo hi > /tmp/x"),
		).rejects.toMatchObject({ code: "SQL_META_COMMAND" });
		expect(h.state.inputs).toEqual([]);
		expect(auditMeta()).toEqual({
			ok: false,
			blocked: "SQL_META_COMMAND",
			bytes: 19,
			statement: "\\! echo hi > /tmp/x",
		});
	});

	it("cuts a long statement before hiding it, so the log stays small", async () => {
		h.state.auditChars = 40;
		await applyDbSql(actor, "app-1", `select ${"1, ".repeat(100)}2;`);
		const statement = auditMeta()?.statement as string;
		expect(statement.length).toBeLessThanOrEqual(40);
		expect(statement.startsWith("select 1, 1,")).toBe(true);
	});
});

describe("applyDbSql: risky statements need an acknowledgement (G-24)", () => {
	it("refuses DROP SCHEMA without it: nothing runs, the attempt is audited", async () => {
		await expect(
			applyDbSql(actor, "app-1", "drop schema auth cascade"),
		).rejects.toMatchObject({
			code: "SQL_RISK_NOT_ACKNOWLEDGED",
			// Risk ids, translated where the error is shown.
			params: { risks: { $terms: { set: "sql_risk", ids: ["drop_schema"] } } },
		});
		expect(h.state.inputs).toEqual([]);
		expect(auditMeta()).toEqual({
			ok: false,
			blocked: "SQL_RISK_NOT_ACKNOWLEDGED",
			bytes: 24,
			statement: "drop schema auth cascade",
			risks: ["drop_schema"],
		});
	});

	it("runs it once acknowledged, and audits which risks were accepted", async () => {
		const result = await applyDbSql(
			actor,
			"app-1",
			"drop schema auth cascade",
			true,
		);
		expect(result.ok).toBe(true);
		expect(h.state.inputs).toEqual(["drop schema auth cascade"]);
		expect(auditMeta()).toEqual({
			ok: true,
			bytes: 24,
			statement: "drop schema auth cascade",
			risks: ["drop_schema"],
			acknowledged: true,
		});
	});

	it("uses the schemas the app's template manages", async () => {
		await expect(
			applyDbSql(actor, "app-1", "create table storage.t(x int)"),
		).rejects.toMatchObject({ code: "SQL_RISK_NOT_ACKNOWLEDGED" });
		h.state.managed = [];
		const result = await applyDbSql(
			actor,
			"app-1",
			"create table storage.t(x int)",
		);
		expect(result.ok).toBe(true);
	});

	it("does not ask for a plain statement or for code that only reads auth.uid()", async () => {
		await applyDbSql(
			actor,
			"app-1",
			"create or replace function public.me() returns uuid language sql as $$select auth.uid()$$;",
		);
		expect(h.state.inputs).toHaveLength(1);
		expect(auditMeta()).not.toHaveProperty("risks");
		expect(auditMeta()).not.toHaveProperty("acknowledged");
	});
});
