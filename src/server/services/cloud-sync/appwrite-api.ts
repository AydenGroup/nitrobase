import type {
	AppwriteConnectionConfig,
	CloudSyncProvider,
} from "#/config/cloud-sync.ts";
import { getConfig } from "#/config/server.ts";
import { AppError } from "#/utils/error.ts";
import { type CloudMethod, cloudJson, cloudRequest } from "./http";

/**
 * Appwrite Cloud as the import reads it before the job (connection test,
 * preflight, the counts the job compares with): the project's REST API
 * with its API key (`X-Appwrite-Project` / `X-Appwrite-Key`), through the
 * shared pinned client (allowlisted hosts only). Lists are counted with
 * `limit` queries, a bounded number of pages each.
 */

/** A list query (`queries[]`, JSON form since Appwrite 1.5). */
export function listQuery(
	method: "limit" | "cursorAfter",
	value: number | string,
): string {
	return JSON.stringify({ method, values: [value] });
}

/** `<endpoint><path>?queries[]=...` (path segments already encoded). */
export function appwriteUrl(
	endpoint: string,
	path: string,
	queries: string[] = [],
): string {
	const url = new URL(`${endpoint.replace(/\/+$/, "")}${path}`);
	for (const query of queries) url.searchParams.append("queries[]", query);
	return url.toString();
}

const segment = (value: string) => encodeURIComponent(value);

/**
 * Databases API by Appwrite version: TablesDB (1.8+), else the legacy
 * collections/documents API (same data, other names).
 */
const DATABASE_APIS = [
	{
		databases: "/tablesdb",
		tables: (db: string) => `/tablesdb/${segment(db)}/tables`,
		tablesKey: "tables",
		rows: (db: string, table: string) =>
			`/tablesdb/${segment(db)}/tables/${segment(table)}/rows`,
	},
	{
		databases: "/databases",
		tables: (db: string) => `/databases/${segment(db)}/collections`,
		tablesKey: "collections",
		rows: (db: string, table: string) =>
			`/databases/${segment(db)}/collections/${segment(table)}/documents`,
	},
] as const;

/** Appwrite's error body (`{ message, code, type }`), when it is one. */
function appwriteErrorType(detail: string): string | null {
	try {
		const body = JSON.parse(detail) as { type?: unknown };
		return typeof body.type === "string" ? body.type : null;
	} catch {
		return null;
	}
}

/**
 * Coded error of a failed cloud read: a used-up read quota (HTTP 402 on
 * the Free plan) gets its own code; the rest stay as `cloudRequest` made
 * them.
 */
export function mapCloudError(error: unknown): unknown {
	if (
		error instanceof AppError &&
		error.code === "CLOUD_API_FAILED" &&
		(error.params as { status?: number }).status === 402
	) {
		return new AppError("CLOUD_APPWRITE_READ_QUOTA", {
			detail: String((error.params as { detail?: string }).detail ?? ""),
		});
	}
	return error;
}

/** A missing scope (or a wrong key/project): the read was refused. */
export function isRefused(error: unknown): boolean {
	return error instanceof AppError && error.code === "CLOUD_API_UNAUTHORIZED";
}

interface AppwriteListPage {
	total: number;
	items: Record<string, unknown>[];
}

/** What a cloud project holds, per import part (null: not readable). */
export interface AppwriteSourceCounts {
	/** Migration resource → count (the job compares them with its counters). */
	resources: Record<string, { count: number; atLeast: boolean }>;
	/** Bytes of the files (null: not counted). */
	fileBytes: number | null;
	functionNames: string[];
	/** Resources the key could not read. */
	refused: string[];
	/** Some counts are lower bounds. */
	partial: boolean;
}

export interface AppwriteApi {
	version(): Promise<string>;
	/** One page of a list (`limit`, optional cursor). */
	list(
		path: string,
		key: string,
		options?: { limit?: number; cursor?: string },
	): Promise<AppwriteListPage>;
	/** The project's name (null: the key cannot read the project). */
	projectName(): Promise<string | null>;
}

export function appwriteApi(
	provider: CloudSyncProvider,
	config: AppwriteConnectionConfig,
): AppwriteApi {
	const headers = {
		"x-appwrite-project": config.projectId,
		"x-appwrite-key": config.apiKey,
	};
	const get = async <T>(
		path: string,
		queries: string[] = [],
		auth: "key" | "public" = "key",
	) => {
		try {
			return await cloudJson<T>(provider, {
				url: appwriteUrl(config.endpoint, path, queries),
				// A key without the `public` scope is refused on public
				// endpoints (`/health/version`): those go without it.
				headers:
					auth === "key" ? headers : { "x-appwrite-project": config.projectId },
			});
		} catch (error) {
			throw mapCloudError(error);
		}
	};
	return {
		version: async () => {
			const body = await get<{ version?: unknown }>(
				"/health/version",
				[],
				"public",
			);
			if (typeof body.version !== "string" || !body.version) {
				throw new AppError("CLOUD_API_INVALID_RESPONSE", {
					detail: JSON.stringify(body).slice(0, 200),
				});
			}
			return body.version;
		},
		list: async (path, key, options = {}) => {
			const queries = [listQuery("limit", options.limit ?? 1)];
			if (options.cursor)
				queries.push(listQuery("cursorAfter", options.cursor));
			const body = await get<Record<string, unknown>>(path, queries);
			const items = body[key];
			return {
				total: typeof body.total === "number" ? body.total : 0,
				items: Array.isArray(items) ? (items as Record<string, unknown>[]) : [],
			};
		},
		projectName: async () => {
			try {
				const body = await get<{ name?: unknown }>("/project");
				return typeof body.name === "string" && body.name ? body.name : null;
			} catch (error) {
				if (isRefused(error) || isNotFound(error)) return null;
				throw error;
			}
		},
	};
}

function isNotFound(error: unknown): boolean {
	return (
		error instanceof AppError &&
		error.code === "CLOUD_API_FAILED" &&
		(error.params as { status?: number }).status === 404
	);
}

/** Every item of a list, at most `maxPages` pages (then `complete: false`). */
async function listAll(
	api: AppwriteApi,
	path: string,
	key: string,
): Promise<{
	total: number;
	items: Record<string, unknown>[];
	complete: boolean;
}> {
	const config = getConfig();
	const items: Record<string, unknown>[] = [];
	let total = 0;
	let cursor: string | undefined;
	for (let page = 0; page < config.CLOUD_SYNC_APPWRITE_MAX_PAGES; page++) {
		const result = await api.list(path, key, {
			limit: config.CLOUD_SYNC_APPWRITE_PAGE_SIZE,
			cursor,
		});
		total = result.total;
		items.push(...result.items);
		const last = result.items.at(-1)?.$id;
		if (
			result.items.length < config.CLOUD_SYNC_APPWRITE_PAGE_SIZE ||
			typeof last !== "string"
		) {
			return { total, items, complete: true };
		}
		cursor = last;
	}
	return { total, items, complete: false };
}

const idOf = (item: Record<string, unknown>) =>
	typeof item.$id === "string" ? item.$id : null;

/**
 * Count what the selected migration resources would copy. A resource the
 * key cannot read is listed in `refused` (not an error): the preflight
 * warns, the migration itself reports what it could not copy.
 */
export async function countSource(
	api: AppwriteApi,
	resources: readonly string[],
): Promise<AppwriteSourceCounts> {
	const config = getConfig();
	const cap = config.CLOUD_SYNC_APPWRITE_COUNT_CAP;
	const counts: AppwriteSourceCounts = {
		resources: {},
		fileBytes: null,
		functionNames: [],
		refused: [],
		partial: false,
	};
	const wants = (resource: string) => resources.includes(resource);
	const set = (resource: string, count: number, atLeast = false) => {
		const lowerBound = atLeast || count >= cap;
		counts.resources[resource] = { count, atLeast: lowerBound };
		if (lowerBound) counts.partial = true;
	};
	const guarded = async (names: string[], fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (error) {
			if (!isRefused(error)) throw error;
			counts.refused.push(...names.filter(wants));
		}
	};

	if (wants("user")) {
		await guarded(["user"], async () => {
			set("user", (await api.list("/users", "users")).total);
		});
	}
	if (wants("team") || wants("membership")) {
		await guarded(["team", "membership"], async () => {
			const teams = await listAll(api, "/teams", "teams");
			set("team", teams.total, !teams.complete);
			if (wants("membership")) {
				let memberships = 0;
				for (const team of teams.items) {
					memberships += typeof team.total === "number" ? team.total : 0;
				}
				set("membership", memberships, !teams.complete);
			}
		});
	}
	if (wants("database")) {
		await guarded(["database", "table", "column", "index", "row"], async () => {
			const { databases, api: dbApi } = await listDatabases(api);
			set("database", databases.total, !databases.complete);
			let tables = 0;
			let rows = 0;
			let partial = !databases.complete;
			let counted = 0;
			for (const database of databases.items) {
				const id = idOf(database);
				if (!id) continue;
				const list = await listAll(api, dbApi.tables(id), dbApi.tablesKey);
				tables += list.total;
				partial ||= !list.complete;
				if (!wants("row")) continue;
				for (const table of list.items) {
					const tableId = idOf(table);
					if (!tableId) continue;
					if (counted >= config.CLOUD_SYNC_APPWRITE_MAX_TABLES) {
						partial = true;
						break;
					}
					counted++;
					const total = (await api.list(dbApi.rows(id, tableId), "rows")).total;
					rows += total;
					partial ||= total >= cap;
				}
			}
			if (wants("table")) set("table", tables, partial);
			if (wants("row")) set("row", rows, partial);
		});
	}
	if (wants("bucket") || wants("file")) {
		await guarded(["bucket", "file"], async () => {
			const buckets = await listAll(api, "/storage/buckets", "buckets");
			set("bucket", buckets.total, !buckets.complete);
			if (!wants("file")) return;
			let files = 0;
			let bytes = 0;
			let partial = !buckets.complete;
			for (const bucket of buckets.items) {
				const id = idOf(bucket);
				if (!id) continue;
				const list = await listAll(
					api,
					`/storage/buckets/${segment(id)}/files`,
					"files",
				);
				files += list.total;
				const listed = list.items.reduce(
					(sum, file) =>
						sum +
						(typeof file.sizeOriginal === "number" ? file.sizeOriginal : 0),
					0,
				);
				// Pages not read: estimated from the average file read.
				bytes +=
					list.items.length > 0 && list.total > list.items.length
						? Math.ceil((listed / list.items.length) * list.total)
						: listed;
				partial ||= !list.complete;
			}
			set("file", files, partial);
			counts.fileBytes = bytes;
		});
	}
	if (wants("function") || wants("deployment")) {
		await guarded(
			["function", "deployment", "environment-variable"],
			async () => {
				const functions = await listAll(api, "/functions", "functions");
				set("function", functions.total, !functions.complete);
				counts.functionNames = functions.items
					.map((fn) => (typeof fn.name === "string" ? fn.name : idOf(fn)))
					.filter((name): name is string => !!name);
			},
		);
	}
	if (wants("platform")) {
		await guarded(["platform"], async () => {
			try {
				set(
					"platform",
					(await api.list("/project/platforms", "platforms")).total,
				);
			} catch (error) {
				// Older Appwrite: platforms are console-only (not counted).
				if (!isNotFound(error)) throw error;
			}
		});
	}
	return counts;
}

/** The databases list, from the first API this Appwrite version serves. */
async function listDatabases(api: AppwriteApi) {
	let lastError: unknown = null;
	for (const dbApi of DATABASE_APIS) {
		try {
			return {
				databases: await listAll(api, dbApi.databases, "databases"),
				api: dbApi,
			};
		} catch (error) {
			if (!isNotFound(error)) throw error;
			lastError = error;
		}
	}
	throw lastError;
}

/** Cloud resources an export needs empty, as `countEmptiness` lists them. */
const EMPTINESS_PROBES = [
	{ resource: "user", path: "/users", key: "users" },
	{ resource: "team", path: "/teams", key: "teams" },
	{ resource: "bucket", path: "/storage/buckets", key: "buckets" },
	{ resource: "function", path: "/functions", key: "functions" },
] as const;

/**
 * What an export would collide with in the cloud project (totals per
 * resource; `refused`: resources the key cannot read, so emptiness is
 * unknown).
 */
export async function countEmptiness(
	api: AppwriteApi,
): Promise<{ counts: Record<string, number>; refused: string[] }> {
	const counts: Record<string, number> = {};
	const refused: string[] = [];
	const guarded = async (resource: string, fn: () => Promise<number>) => {
		try {
			counts[resource] = await fn();
		} catch (error) {
			if (!isRefused(error)) throw error;
			refused.push(resource);
		}
	};
	for (const probe of EMPTINESS_PROBES) {
		await guarded(
			probe.resource,
			async () => (await api.list(probe.path, probe.key)).total,
		);
	}
	await guarded("database", async () => {
		const { databases } = await listDatabases(api);
		return databases.total;
	});
	// An exported part too: a project with platforms is not empty.
	await guarded("platform", async () => {
		try {
			return (await api.list("/project/platforms", "platforms")).total;
		} catch (error) {
			// Older Appwrite: platforms are console-only (none via a key).
			if (isNotFound(error)) return 0;
			throw error;
		}
	});
	return { counts, refused };
}

/**
 * The cloud project as an export writes to it: Appwrite's migrations on
 * the cloud (the destination pulls from the app), with the connection's
 * key. Starting one is never retried (it would run twice).
 */
export function appwriteCloud(
	provider: CloudSyncProvider,
	config: AppwriteConnectionConfig,
) {
	const headers = {
		"x-appwrite-project": config.projectId,
		"x-appwrite-key": config.apiKey,
		accept: "application/json",
	};
	const call = async (
		method: CloudMethod,
		path: string,
		body?: unknown,
	): Promise<unknown> => {
		try {
			const response = await cloudRequest(provider, {
				url: appwriteUrl(config.endpoint, path),
				method,
				headers:
					body === undefined
						? headers
						: { ...headers, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = response.body.toString("utf8");
			return text ? (JSON.parse(text) as unknown) : null;
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new AppError("CLOUD_API_INVALID_RESPONSE", { detail: "" });
			}
			throw mapCloudError(error);
		}
	};
	const migration = (id: string) => `/migrations/${segment(id)}`;
	return {
		startMigration: async (source: {
			endpoint: string;
			projectId: string;
			apiKey: string;
			resources: string[];
		}) =>
			call("POST", "/migrations/appwrite", {
				resources: source.resources,
				endpoint: source.endpoint,
				projectId: source.projectId,
				apiKey: source.apiKey,
				onDuplicate: "fail",
			}),
		getMigration: (id: string) => call("GET", migration(id)),
		retryMigration: async (id: string) => {
			await call("PATCH", migration(id));
		},
		/** Remove a migration: its document stores the app's key. */
		deleteMigration: async (id: string) => {
			try {
				await call("DELETE", migration(id));
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
		},
		/**
		 * Whether the key may start migrations (`migrations.write`), without
		 * starting one: the report endpoint checks that scope first, so only
		 * a refused scope means no (any other answer passed the check).
		 */
		canStartMigrations: async (): Promise<boolean> => {
			const url = new URL(
				appwriteUrl(config.endpoint, "/migrations/appwrite/report"),
			);
			url.searchParams.append("resources[]", "user");
			url.searchParams.append("endpoint", config.endpoint);
			// Both spellings: unverified which one the report reads.
			url.searchParams.append("projectId", config.projectId);
			url.searchParams.append("projectID", config.projectId);
			url.searchParams.append("key", "-");
			try {
				await cloudRequest(provider, {
					url: url.toString(),
					headers,
					retry: false,
				});
				return true;
			} catch (error) {
				if (
					error instanceof AppError &&
					(error.code === "CLOUD_API_UNAUTHORIZED" ||
						error.code === "CLOUD_API_FAILED")
				) {
					const detail = String(
						(error.params as { detail?: string }).detail ?? "",
					);
					return appwriteErrorType(detail) !== "general_unauthorized_scope";
				}
				throw error;
			}
		},
	};
}

export type AppwriteCloud = ReturnType<typeof appwriteCloud>;

/** Scope probes of a connection test: what each import part reads first. */
export const SCOPE_PROBES = [
	{ resource: "users", path: "/users", key: "users" },
	{ resource: "teams", path: "/teams", key: "teams" },
	{ resource: "databases", path: DATABASE_APIS[0].databases, key: "databases" },
	{ resource: "buckets", path: "/storage/buckets", key: "buckets" },
	{ resource: "functions", path: "/functions", key: "functions" },
] as const;
