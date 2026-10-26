import { randomBytes } from "node:crypto";
import path from "node:path";
import type { CloudSyncProvider } from "#/config/cloud-sync.ts";
import { getConfig } from "#/config/server.ts";
import { APP_ID } from "#/config/shared.ts";
import { asList } from "#/libs/coded.ts";
import {
	assertFunctionFilePath,
	type FunctionFile,
	SHARED_DIR_PATTERN,
} from "#/server/services/supabase/edge-functions.ts";
import { AppError } from "#/utils/error.ts";
import { cloudJson, cloudRequest } from "./http";
import {
	buildMultipart,
	type FormPart,
	multipartBoundary,
	parseMultipart,
} from "./multipart";

/**
 * Supabase Management API (https://api.supabase.com/api/v1, bearer =
 * personal access token): the project, its session pooler, the pgsodium
 * root key, edge function sources and (export) function deploys. Rate
 * limit: 120 requests/minute per token (429s are retried by `cloudRequest`).
 */

/**
 * Folder the files of a deploy are named under, like the Supabase CLI
 * sends them (`supabase/functions/<slug>/index.ts`, shared code in
 * `supabase/functions/_shared/…`): `entrypoint_path` uses the same root.
 */
export const FUNCTION_UPLOAD_ROOT = "supabase/functions";

/** A function to deploy (`POST /v1/projects/{ref}/functions/deploy`). */
export interface FunctionDeploy {
	slug: string;
	/** Entrypoint inside the function folder (e.g. `index.ts`). */
	entrypoint: string;
	/** Import map inside the function folder (e.g. `deno.json`). */
	importMap: string | null;
	verifyJwt: boolean;
	/** Files of the function folder (paths relative to it). */
	files: { path: string; content: Buffer }[];
	/** Sibling `_name` folders it imports, by folder name. */
	shared: Record<string, { path: string; content: Buffer }[]>;
}

/** The multipart parts of a deploy (pure: metadata + one part per file). */
export function deployParts(deploy: FunctionDeploy): FormPart[] {
	const root = `${FUNCTION_UPLOAD_ROOT}/${deploy.slug}`;
	const metadata = {
		name: deploy.slug,
		entrypoint_path: `${root}/${deploy.entrypoint}`,
		...(deploy.importMap
			? { import_map_path: `${root}/${deploy.importMap}` }
			: {}),
		verify_jwt: deploy.verifyJwt,
	};
	const file = (path: string, content: Buffer): FormPart => ({
		name: "file",
		filename: path,
		contentType: "application/octet-stream",
		data: content,
	});
	return [
		{
			name: "metadata",
			contentType: "application/json",
			data: JSON.stringify(metadata),
		},
		...deploy.files.map((item) => file(`${root}/${item.path}`, item.content)),
		...Object.entries(deploy.shared).flatMap(([dir, files]) =>
			files.map((item) =>
				file(`${FUNCTION_UPLOAD_ROOT}/${dir}/${item.path}`, item.content),
			),
		),
	];
}

interface SupabaseProject {
	ref: string;
	name: string;
	region: string;
	status: string;
	database?: { host?: string; version?: string; postgres_engine?: string };
}

export interface SupabasePooler {
	database_type: string;
	pool_mode: string;
	db_host: string;
	db_port: number;
	db_user: string;
	db_name: string;
}

export interface SupabaseFunction {
	slug: string;
	name: string;
	status: string;
	version: number;
	verify_jwt?: boolean;
	entrypoint_path?: string;
	import_map_path?: string;
}

export interface SupabaseApi {
	project(): Promise<SupabaseProject>;
	pooler(): Promise<SupabasePooler>;
	/** The pgsodium/Vault root key (hex), or null when not readable. */
	rootKey(): Promise<string | null>;
	functions(): Promise<SupabaseFunction[]>;
	functionBody(fn: SupabaseFunction): Promise<FunctionSource>;
	/** Deploy (create or replace) a function from its source files. */
	deployFunction(deploy: FunctionDeploy): Promise<SupabaseFunction>;
}

export function supabaseApi(
	provider: CloudSyncProvider,
	ref: string,
	token: string,
): SupabaseApi {
	const base = getConfig().CLOUD_SYNC_SUPABASE_API_URL.replace(/\/+$/, "");
	const auth = { authorization: `Bearer ${token}` };
	const url = (suffix: string) =>
		`${base}/v1/projects/${encodeURIComponent(ref)}${suffix}`;
	return {
		project: () => cloudJson(provider, { url: url(""), headers: auth }),
		pooler: async () => {
			const configs = await cloudJson<SupabasePooler[]>(provider, {
				url: url("/config/database/pooler"),
				headers: auth,
			});
			const pooler = pickSessionPooler(configs);
			if (!pooler) throw new AppError("CLOUD_POOLER_NOT_FOUND");
			return pooler;
		},
		rootKey: async () => {
			try {
				const result = await cloudJson<{ root_key?: string }>(provider, {
					url: url("/pgsodium"),
					headers: auth,
				});
				return result.root_key && /^[0-9a-f]{64}$/i.test(result.root_key)
					? result.root_key.toLowerCase()
					: null;
			} catch (error) {
				// Beta endpoint: not every plan/token may read it.
				if (
					error instanceof AppError &&
					(error.code === "CLOUD_API_FAILED" ||
						error.code === "CLOUD_API_UNAUTHORIZED")
				) {
					return null;
				}
				throw error;
			}
		},
		functions: async () =>
			(
				await cloudJson<SupabaseFunction[]>(provider, {
					url: url("/functions"),
					headers: auth,
				})
			).filter((fn) => fn.status !== "REMOVED"),
		functionBody: async (fn) => {
			const response = await cloudRequest(provider, {
				url: url(`/functions/${encodeURIComponent(fn.slug)}/body`),
				headers: { ...auth, accept: "multipart/form-data" },
				maxBytes: getConfig().CLOUD_SYNC_FUNCTION_MAX_BYTES,
			});
			const header = response.headers["content-type"];
			const boundary = multipartBoundary(
				Array.isArray(header) ? header[0] : header,
			);
			if (!boundary) {
				// An ESZIP bundle (older deploys): no sources to unpack here.
				throw new AppError("CLOUD_FUNCTION_NOT_SOURCE", { name: fn.slug });
			}
			return functionSource(
				parseMultipart(response.body, boundary),
				fn.entrypoint_path ?? null,
			);
		},
		deployFunction: async (deploy) => {
			const boundary = `${APP_ID}-${randomBytes(12).toString("hex")}`;
			const response = await cloudRequest(provider, {
				url: `${url("/functions/deploy")}?slug=${encodeURIComponent(deploy.slug)}`,
				method: "POST",
				headers: {
					...auth,
					accept: "application/json",
					"content-type": `multipart/form-data; boundary=${boundary}`,
				},
				body: buildMultipart(deployParts(deploy), boundary),
				// A deploy replaces the function by slug: safe to repeat.
				retry: true,
			});
			try {
				return JSON.parse(response.body.toString("utf8")) as SupabaseFunction;
			} catch {
				return { slug: deploy.slug, name: deploy.slug, status: "", version: 0 };
			}
		},
	};
}

/** The primary database's session-mode pooler. */
export function pickSessionPooler(
	configs: SupabasePooler[],
): SupabasePooler | null {
	const primary = configs.filter(
		(config) => (config.database_type ?? "PRIMARY") === "PRIMARY",
	);
	return primary.find((config) => config.pool_mode === "session") ?? null;
}

/** `17.4.1.054` / `PostgreSQL 15.8 …` → 17 / 15. */
export function postgresMajor(version: string | undefined | null) {
	const match = /(\d+)(?:\.\d+)*/.exec(version ?? "");
	const major = match ? Number(match[1]) : Number.NaN;
	return Number.isInteger(major) && major >= 9 ? major : null;
}

export interface FunctionSource {
	/** Files of the function folder (paths relative to it). */
	files: FunctionFile[];
	/** Sibling `_name` folders the function imports (e.g. `_shared`). */
	shared: Record<string, FunctionFile[]>;
	/** Server paths that resolve outside both (not imported). */
	skipped: string[];
	/** The entrypoint inside the function folder (e.g. `index.ts`), if known. */
	entrypoint: string | null;
}

/**
 * Map the multipart parts of a function download to files, like the CLI
 * (`supabase functions download --use-api`, download.go `saveFile`): each
 * part lands relative to the entrypoint's folder, with the entrypoint and
 * the parts resolved from the same root (see `resolveRoot`). The server
 * sends absolute paths (`/tmp/user_fn_x/source/index.ts`) or paths
 * relative to a common root (`functions/hello/index.ts` +
 * `functions/_shared/x.ts`, or the `supabase/functions/<slug>/…` names of
 * a CLI deploy or `deployParts`). `../_shared/x.ts` lands in a sibling
 * folder. Paths are server-controlled: anything else outside is skipped,
 * never written.
 */
export function functionSource(
	parts: ReturnType<typeof parseMultipart>,
	fallbackEntrypoint: string | null,
): FunctionSource {
	let entrypoint: string | null = null;
	const metadata = parts.find((part) => part.name === "metadata");
	if (metadata) {
		try {
			const parsed = JSON.parse(metadata.data.toString("utf8")) as {
				deno2_entrypoint_path?: string;
			};
			entrypoint = parsed.deno2_entrypoint_path || null;
		} catch {
			entrypoint = null;
		}
	}
	entrypoint ||= fallbackEntrypoint || null;
	const sources = parts.flatMap((part) => {
		if (part === metadata) return [];
		const partPath = part.headers["supabase-path"] || part.filename;
		return partPath ? [{ part, partPath }] : [];
	});
	const { entry, relativeRoot } = resolveRoot(
		entrypoint ? serverPath(entrypoint) : null,
		sources.map((item) => item.partPath),
	);
	const base = entry ? path.posix.dirname(entry) : "/";
	const result: FunctionSource = {
		files: [],
		shared: {},
		skipped: [],
		entrypoint: entry ? path.posix.relative(base, entry) : null,
	};
	for (const { part, partPath } of sources) {
		const absolute = path.posix.isAbsolute(partPath)
			? path.posix.normalize(partPath)
			: path.posix.join(relativeRoot, partPath);
		const relative = path.posix.relative(base, absolute);
		const file = (filePath: string) => ({
			path: assertFunctionFilePath(filePath),
			// Bytes as sent: wasm, images and fonts must not go through text.
			content: Buffer.from(part.data),
		});
		if (relative !== ".." && !relative.startsWith("../")) {
			try {
				result.files.push(file(relative));
			} catch {
				result.skipped.push(partPath);
			}
			continue;
		}
		const [dir = "", ...rest] = relative.slice(3).split("/");
		if (!SHARED_DIR_PATTERN.test(dir) || rest.length === 0) {
			result.skipped.push(partPath);
			continue;
		}
		try {
			result.shared[dir] = [
				...(result.shared[dir] ?? []),
				file(rest.join("/")),
			];
		} catch {
			result.skipped.push(partPath);
		}
	}
	return result;
}

/**
 * A downloaded function must have its entrypoint at the root of its folder
 * (one of the template's entrypoint names, or the entrypoint the cloud
 * reports), else the self-hosted runtime cannot start it: refuse it, naming
 * what was found, instead of writing an unusable folder.
 */
export function assertFunctionEntrypoint(
	name: string,
	source: FunctionSource,
	entrypoints: string[],
): void {
	const names = new Set(entrypoints);
	if (source.entrypoint && !source.entrypoint.includes("/")) {
		names.add(source.entrypoint);
	}
	if (source.files.some((file) => names.has(file.path))) return;
	throw new AppError("CLOUD_FUNCTION_NO_ENTRYPOINT", {
		name,
		expected: asList([...names]),
		found: asList(topLevelEntries(source.files.map((file) => file.path))),
	});
}

/** What sits at the root of a function folder (`index.ts`, `lib/`), sorted. */
export function topLevelEntries(paths: string[]): string[] {
	const entries = new Set(
		paths.map((item) => {
			const slash = item.indexOf("/");
			return slash === -1 ? item : `${item.slice(0, slash)}/`;
		}),
	);
	return [...entries].sort();
}

/**
 * The entrypoint as an absolute path (in a virtual root when the server
 * sent relative paths) and the folder relative part paths resolve from, so
 * the entrypoint and the parts come from one root (pure):
 * - relative entrypoint: relative parts share its root; an absolute part
 *   ending with `/<entrypoint>` anchors that root.
 * - absolute entrypoint (e.g. a dashboard deploy with relative parts): the
 *   longest relative part it ends with anchors the root of the relative
 *   parts, else they resolve from the entrypoint's folder.
 * Absolute parts are always used as sent.
 */
function resolveRoot(
	entrypoint: string | null,
	partPaths: string[],
): { entry: string | null; relativeRoot: string } {
	if (!entrypoint) return { entry: null, relativeRoot: "/" };
	const rootOf = (full: string, tail: string) =>
		full.endsWith(`/${tail}`) ? full.slice(0, -tail.length) : null;
	if (!path.posix.isAbsolute(entrypoint)) {
		const anchored = partPaths
			.filter((item) => path.posix.isAbsolute(item))
			.map((item) => rootOf(path.posix.normalize(item), entrypoint))
			.find((root): root is string => root !== null);
		const relativeRoot = anchored ?? "/";
		return { entry: path.posix.join(relativeRoot, entrypoint), relativeRoot };
	}
	const tails = partPaths
		.filter((item) => !path.posix.isAbsolute(item))
		.map((item) => serverPath(item))
		.filter((item) => item !== ".." && !item.startsWith("../"))
		.sort((a, b) => b.length - a.length);
	for (const tail of tails) {
		const root = rootOf(entrypoint, tail);
		if (root) return { entry: entrypoint, relativeRoot: root };
	}
	return { entry: entrypoint, relativeRoot: path.posix.dirname(entrypoint) };
}

/**
 * `file:///tmp/fn/source/index.ts` → `/tmp/fn/source/index.ts`; a plain
 * path stays absolute or relative (normalized, without `./`).
 */
function serverPath(value: string): string {
	if (/^file:/i.test(value)) {
		try {
			return path.posix.normalize(decodeURIComponent(new URL(value).pathname));
		} catch {
			// Not a valid URL: treat it as a plain path.
		}
	}
	const normalized = path.posix.normalize(value);
	return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}
