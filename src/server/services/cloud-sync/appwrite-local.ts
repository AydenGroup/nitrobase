import { TEXT_LIMITS } from "#/config/text-limits.ts";
import type { CloudSyncSummary } from "#/db/schema/cloud-sync.ts";
import type { AppwritePluginConfig } from "#/features/appwrite/schema.ts";
import { clip } from "#/libs/format.ts";
import type { GatewayMethod } from "#/server/services/gateway.ts";
import { AppError } from "#/utils/error.ts";
import { type AppwriteSourceCounts, listQuery } from "./appwrite-api";

/**
 * The new app's Appwrite as an import drives it (pure parts): requests to
 * its REST API (console bootstrap, the migration) and what their answers
 * mean. They are sent by a throwaway curl container on the proxy network
 * (#/server/services/gateway.ts), credentials in the curl config on stdin.
 */

export interface LocalRequest {
	method: GatewayMethod;
	/** Path under the API prefix (`/account`, `/migrations/appwrite`). */
	path: string;
	/** Percent-encoded query string (`encodeQueries`). */
	query?: string;
	headers: Record<string, string>;
	body?: unknown;
}

/** Who a request acts as: the console session, or a project key. */
export type LocalAuth =
	| { kind: "console" }
	| { kind: "session"; cookie: string }
	/** The console admin acting on a project (as the console does). */
	| { kind: "admin"; project: string; cookie: string }
	| { kind: "key"; project: string; secret: string };

function authHeaders(
	plugin: AppwritePluginConfig,
	auth: LocalAuth,
): Record<string, string> {
	switch (auth.kind) {
		case "console":
			return { "X-Appwrite-Project": plugin.console_project };
		case "session":
			return {
				"X-Appwrite-Project": plugin.console_project,
				Cookie: auth.cookie,
			};
		case "admin":
			return {
				"X-Appwrite-Project": auth.project,
				"X-Appwrite-Mode": "admin",
				Cookie: auth.cookie,
			};
		case "key":
			return {
				"X-Appwrite-Project": auth.project,
				"X-Appwrite-Key": auth.secret,
			};
	}
}

const request = (
	plugin: AppwritePluginConfig,
	auth: LocalAuth,
	method: GatewayMethod,
	path: string,
	body?: unknown,
): LocalRequest => ({
	method,
	path,
	headers: {
		...authHeaders(plugin, auth),
		...(body !== undefined ? { "Content-Type": "application/json" } : {}),
	},
	...(body !== undefined ? { body } : {}),
});

const segment = (value: string) => encodeURIComponent(value);

/** `queries[]=…` list queries, percent-encoded for the gateway's `query`. */
export function encodeQueries(queries: string[]): string {
	const search = new URLSearchParams();
	for (const query of queries) search.append("queries[]", query);
	return search
		.toString()
		.replace(
			/[!'()]/g,
			(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
		);
}

/** Requests of an import, in the order the job sends them. */
export const localRequests = {
	health: (plugin: AppwritePluginConfig) =>
		request(plugin, { kind: "console" }, "GET", "/health/version"),
	createAccount: (
		plugin: AppwritePluginConfig,
		input: { email: string; password: string; name: string },
	) =>
		request(plugin, { kind: "console" }, "POST", "/account", {
			userId: "unique()",
			email: input.email,
			password: input.password,
			name: input.name,
		}),
	createSession: (
		plugin: AppwritePluginConfig,
		input: { email: string; password: string },
	) =>
		request(plugin, { kind: "console" }, "POST", "/account/sessions/email", {
			email: input.email,
			password: input.password,
		}),
	deleteSession: (plugin: AppwritePluginConfig, cookie: string) =>
		request(
			plugin,
			{ kind: "session", cookie },
			"DELETE",
			"/account/sessions/current",
		),
	/** Projects of the console (export: which one to read). */
	listProjects: (plugin: AppwritePluginConfig, cookie: string) => ({
		...request(plugin, { kind: "session", cookie }, "GET", "/projects"),
		query: encodeQueries([listQuery("limit", 100)]),
	}),
	/** One page of a list in a project (export counts). */
	list: (
		plugin: AppwritePluginConfig,
		auth: LocalAuth,
		path: string,
		queries: string[],
	): LocalRequest => ({
		...request(plugin, auth, "GET", path),
		...(queries.length ? { query: encodeQueries(queries) } : {}),
	}),
	listTeams: (plugin: AppwritePluginConfig, cookie: string) =>
		request(plugin, { kind: "session", cookie }, "GET", "/teams"),
	createTeam: (plugin: AppwritePluginConfig, cookie: string, name: string) =>
		request(plugin, { kind: "session", cookie }, "POST", "/teams", {
			teamId: "unique()",
			name,
		}),
	createProject: (
		plugin: AppwritePluginConfig,
		cookie: string,
		input: { projectId: string; name: string; teamId: string },
	) =>
		request(plugin, { kind: "session", cookie }, "POST", "/projects", {
			projectId: input.projectId,
			name: input.name,
			teamId: input.teamId,
		}),
	createKey: (
		plugin: AppwritePluginConfig,
		cookie: string,
		input: {
			projectId: string;
			name: string;
			expire: string;
			/** Default: the import's (`sync_key_scopes`). */
			scopes?: string[];
		},
	) =>
		request(
			plugin,
			{ kind: "session", cookie },
			"POST",
			`/projects/${segment(input.projectId)}/keys`,
			{
				// Required since Appwrite 2.x (`unique()`: generated).
				keyId: "unique()",
				name: input.name,
				scopes: input.scopes ?? plugin.sync_key_scopes,
				expire: input.expire,
			},
		),
	deleteKey: (
		plugin: AppwritePluginConfig,
		cookie: string,
		input: { projectId: string; keyId: string },
	) =>
		request(
			plugin,
			{ kind: "session", cookie },
			"DELETE",
			`/projects/${segment(input.projectId)}/keys/${segment(input.keyId)}`,
		),
	/** Destination pulls from the source: called on the NEW project. */
	startMigration: (
		plugin: AppwritePluginConfig,
		key: { project: string; secret: string },
		source: {
			endpoint: string;
			projectId: string;
			apiKey: string;
			resources: string[];
		},
	) =>
		request(plugin, { kind: "key", ...key }, "POST", "/migrations/appwrite", {
			resources: source.resources,
			endpoint: source.endpoint,
			projectId: source.projectId,
			apiKey: source.apiKey,
			onDuplicate: "fail",
		}),
	getMigration: (
		plugin: AppwritePluginConfig,
		key: { project: string; secret: string },
		id: string,
	) =>
		request(
			plugin,
			{ kind: "key", ...key },
			"GET",
			`/migrations/${segment(id)}`,
		),
	/** Remove a finished migration: its document holds the cloud API key. */
	deleteMigration: (
		plugin: AppwritePluginConfig,
		auth: LocalAuth,
		id: string,
	) => request(plugin, auth, "DELETE", `/migrations/${segment(id)}`),
	/** Retry a failed migration. */
	retryMigration: (
		plugin: AppwritePluginConfig,
		key: { project: string; secret: string },
		id: string,
	) =>
		request(
			plugin,
			{ kind: "key", ...key },
			"PATCH",
			`/migrations/${segment(id)}`,
		),
} as const;

/** Migration resources of the selected import parts, in part order. */
export function migrationResources(
	plugin: AppwritePluginConfig,
	parts: readonly string[],
): string[] {
	const resources = parts.flatMap((part) => plugin.sync_resources[part] ?? []);
	return [...new Set(resources)];
}

/**
 * The console session from `Set-Cookie` (`a_session_<project>=...`), as a
 * `Cookie` header value. Null when the answer set none.
 */
export function sessionCookie(
	headers: [string, string][],
	consoleProject: string,
): string | null {
	const name = `a_session_${consoleProject}`;
	for (const [header, value] of headers) {
		if (header.toLowerCase() !== "set-cookie") continue;
		const pair = value.split(";")[0]?.trim() ?? "";
		const eq = pair.indexOf("=");
		if (eq > 0 && pair.slice(0, eq) === name && pair.length > eq + 1) {
			return pair;
		}
	}
	return null;
}

/**
 * Appwrite errors of a console sign-up that mean the console already
 * belongs to someone else (only the first account, or only whitelisted
 * emails, may sign up).
 */
const CONSOLE_CLOSED = new Set([
	"user_email_not_whitelisted",
	"user_console_count_exceeded",
	"user_ip_not_whitelisted",
]);

/**
 * Why the import could not sign in to the new app's console (null: it
 * did). Sign-up refused because the console is closed, or the email exists
 * with another password: someone claimed the console first.
 */
export function consoleSignInError(
	plugin: AppwritePluginConfig,
	email: string,
	account: { status: number | null; body: string },
	session: { status: number | null; body: string },
): AppError | null {
	if (session.status === 201) return null;
	const accountType = errorType(account.body);
	const claimed =
		(accountType !== null && CONSOLE_CLOSED.has(accountType)) ||
		(account.status !== 201 && session.status === 401);
	if (claimed) return new AppError("APPWRITE_CONSOLE_CLAIMED", { email });
	const failed = account.status === 201 ? session : account;
	return new AppError("APPWRITE_REQUEST_FAILED", {
		action: `POST ${plugin.api_path}${failed === account ? "/account" : "/account/sessions/email"}`,
		status: failed.status ?? 0,
		detail: clip(failed.body, TEXT_LIMITS.errorDetail),
	});
}

/** Appwrite's error type of an answer body (e.g. `user_already_exists`). */
function errorType(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as { type?: unknown };
		return typeof parsed.type === "string" ? parsed.type : null;
	} catch {
		return null;
	}
}

type MigrationState = "pending" | "processing" | "completed" | "failed";

export interface MigrationStatus {
	id: string;
	status: MigrationState | string;
	stage: string;
	/** Resource → counter → count (`statusCounters`). */
	counters: Record<string, Record<string, number>>;
	/** Raw error messages (third-party text, shown as details). */
	errors: { resource: string; message: string }[];
}

/** `GET /v1/migrations/{id}` (counters and errors may be JSON strings). */
export function parseMigration(body: unknown): MigrationStatus {
	const value = (body ?? {}) as Record<string, unknown>;
	const parseJson = (raw: unknown): unknown => {
		if (typeof raw !== "string") return raw;
		try {
			return JSON.parse(raw);
		} catch {
			return raw;
		}
	};
	const counters: MigrationStatus["counters"] = {};
	const rawCounters = parseJson(value.statusCounters);
	if (rawCounters && typeof rawCounters === "object") {
		for (const [resource, entry] of Object.entries(rawCounters)) {
			if (!entry || typeof entry !== "object") continue;
			counters[resource] = Object.fromEntries(
				Object.entries(entry as Record<string, unknown>).filter(
					(pair): pair is [string, number] => typeof pair[1] === "number",
				),
			);
		}
	}
	const errors = (Array.isArray(value.errors) ? value.errors : []).map(
		(raw) => {
			const parsed = parseJson(raw);
			if (parsed && typeof parsed === "object") {
				const item = parsed as Record<string, unknown>;
				const resource =
					item.resourceName ?? item.resourceType ?? item.resourceGroup ?? "";
				return {
					resource: String(resource),
					message: String(item.message ?? JSON.stringify(item)),
				};
			}
			return { resource: "", message: String(parsed) };
		},
	);
	return {
		id: String(value.$id ?? ""),
		status: String(value.status ?? ""),
		stage: String(value.stage ?? ""),
		counters,
		errors,
	};
}

/** Counters the job reports: resources done (any outcome) of all known. */
export function migrationProgress(status: MigrationStatus): {
	done: number;
	total: number;
	success: number;
	errors: number;
} {
	let done = 0;
	let total = 0;
	let success = 0;
	let errors = 0;
	for (const entry of Object.values(status.counters)) {
		const get = (key: string) => entry[key] ?? 0;
		const finished =
			get("success") + get("warning") + get("error") + get("skip");
		done += finished;
		total += finished + get("pending") + get("processing");
		success += get("success") + get("warning");
		errors += get("error");
	}
	return { done, total, success, errors };
}

/**
 * Semver-like comparison helper exported for tests lives in
 * appwrite-preflight.ts; here: whether two reads show the same progress.
 */
export function progressKey(status: MigrationStatus): string {
	const progress = migrationProgress(status);
	return `${status.status}|${status.stage}|${progress.done}|${progress.total}`;
}

const MESSAGE_KINDS: { pattern: RegExp; code: AppwriteMigrationErrorCode }[] = [
	{
		pattern: /\b402\b|read_cycle|limit_exceeded|quota/i,
		code: "APPWRITE_SOURCE_QUOTA",
	},
	{
		pattern:
			/unable to connect|could not (?:resolve|connect)|connection (?:refused|reset|timed out)|timed out|ssl|certificate/i,
		code: "APPWRITE_SOURCE_UNREACHABLE",
	},
	{
		pattern:
			/missing (?:required )?scopes?|unauthori[sz]ed|\b401\b|invalid api key|not authorized/i,
		code: "APPWRITE_SOURCE_UNAUTHORIZED",
	},
];

type AppwriteMigrationErrorCode =
	| "APPWRITE_SOURCE_QUOTA"
	| "APPWRITE_SOURCE_UNREACHABLE"
	| "APPWRITE_SOURCE_UNAUTHORIZED"
	| "APPWRITE_MIGRATION_FAILED";

/**
 * A failed migration as a coded error: the first message that names a
 * known cause picks the code; the raw messages are the detail.
 */
export function migrationError(status: MigrationStatus): AppError {
	const messages = status.errors.map((error) =>
		error.resource ? `${error.resource}: ${error.message}` : error.message,
	);
	const detail = clip(messages.join("\n"), TEXT_LIMITS.errorDetail);
	for (const message of messages) {
		const kind = MESSAGE_KINDS.find((item) => item.pattern.test(message));
		if (kind) return new AppError(kind.code, { detail });
	}
	return new AppError("APPWRITE_MIGRATION_FAILED", { detail });
}

/**
 * The migration's counters against the cloud's counts: one summary row per
 * resource, and the ones that did not all arrive (a lower-bound count only
 * flags fewer copied than counted).
 */
export function compareMigration(
	source: AppwriteSourceCounts["resources"],
	status: MigrationStatus,
	resources: readonly string[],
): {
	rows: NonNullable<CloudSyncSummary["resources"]>;
	mismatches: { resource: string; source: number; target: number }[];
} {
	const rows: NonNullable<CloudSyncSummary["resources"]> = [];
	const mismatches: { resource: string; source: number; target: number }[] = [];
	for (const resource of resources) {
		const counter = status.counters[resource] ?? {};
		const target = (counter.success ?? 0) + (counter.warning ?? 0);
		const errors = counter.error ?? 0;
		const counted = source[resource];
		if (!counted && !status.counters[resource]) continue;
		rows.push({
			resource,
			source: counted ? counted.count : null,
			target,
			errors,
		});
		if (!counted) continue;
		const differs = counted.atLeast
			? target < counted.count
			: target !== counted.count;
		if (differs) {
			mismatches.push({ resource, source: counted.count, target });
		}
	}
	return { rows, mismatches };
}
