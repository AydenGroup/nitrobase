import { createHash } from "node:crypto";
import path from "node:path";
import { APP_ID } from "#/config/shared.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import type { ErrorCode } from "#/libs/error-codes.ts";
import { AppError, coded } from "#/utils/error.ts";

/**
 * GitHub client for template sources. Every response is cached through an
 * injected store: list endpoints with a TTL + ETag revalidation, immutable
 * objects (trees by SHA, blobs by SHA) forever. Files are fetched from the
 * Git Trees API scoped to one directory (the full-repo tarball of large
 * monorepos like supabase/supabase is hundreds of MB), pinned to a commit SHA.
 */

export interface CacheEntry {
	etag: string | null;
	payload: unknown;
	fetchedAt: Date;
}

export interface CacheStore {
	get(key: string): Promise<CacheEntry | null>;
	set(key: string, entry: CacheEntry): Promise<void>;
}

export interface GitHubClientOptions {
	apiUrl: string;
	rawUrl: string;
	token?: string;
	cache: CacheStore;
	ttlMs: number;
	fetch?: typeof fetch;
	now?: () => Date;
	/** Per-request timeout. */
	timeoutMs?: number;
}

export interface FetchLimits {
	maxFiles: number;
	maxBytes: number;
}

/** A GitHub API problem: a coded AppError plus the HTTP status (0: none). */
export class GitHubError extends AppError {
	constructor(
		problem: ErrorInfo,
		readonly status: number,
	) {
		super(problem.code as ErrorCode, (problem.params ?? {}) as never);
		this.name = "GitHubError";
	}
}

export class GitHubRateLimitError extends GitHubError {
	constructor(readonly resetAt: Date | null) {
		super(
			resetAt
				? coded("GITHUB_RATE_LIMITED", {
						reset: { $date: resetAt.toISOString() },
					})
				: coded("GITHUB_RATE_LIMITED_SOON"),
			403,
		);
		this.name = "GitHubRateLimitError";
	}
}

export interface RawRelease {
	tag_name: string;
	name: string | null;
	published_at: string | null;
	prerelease: boolean;
	draft: boolean;
	/** Release page (release notes). */
	html_url?: string | null;
}
export interface RawTag {
	name: string;
	commit: { sha: string };
}
export interface RawBranch {
	name: string;
	commit: { sha: string };
}
export interface RawCommit {
	sha: string;
	commit: { message: string; committer: { date: string } | null };
}
interface RawTreeEntry {
	path: string;
	mode: string;
	type: "blob" | "tree" | "commit";
	sha: string;
	size?: number;
}
interface RawTree {
	sha: string;
	tree: RawTreeEntry[];
	truncated: boolean;
}

export interface FetchedFile {
	path: string;
	content: Buffer;
	executable: boolean;
}

/** Git blob object id: sha1("blob <len>\0" + content). */
export function gitBlobSha(content: Buffer): string {
	return createHash("sha1")
		.update(`blob ${content.length}\0`)
		.update(content)
		.digest("hex");
}

/** Validate a repository-relative path from GitHub before using it. */
export function safeRelativePath(value: string): string {
	if (
		!value ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		value
			.split("/")
			.some((part) => part === ".." || part === "." || part === "")
	) {
		throw new GitHubError(
			coded("GITHUB_UNSAFE_PATH", { path: JSON.stringify(value) }),
			0,
		);
	}
	return path.posix.normalize(value);
}

/**
 * A failed fetch's reason: undici only says "fetch failed" and keeps the
 * network error (ENOTFOUND host, ECONNREFUSED…) in `cause`.
 */
export function networkErrorDetail(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause as { code?: string; message?: string } | undefined;
	const reason = cause?.code ?? cause?.message;
	return reason && !error.message.includes(reason)
		? `${error.message} (${reason})`
		: error.message;
}

const encodePath = (value: string) =>
	value.split("/").map(encodeURIComponent).join("/");

export class GitHubAuthError extends GitHubError {
	constructor() {
		super(coded("GITHUB_TOKEN_INVALID"), 401);
		this.name = "GitHubAuthError";
	}
}

export function createGitHubClient(options: GitHubClientOptions) {
	const baseFetch = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? 15_000;
	const doFetch: typeof fetch = (input, init) =>
		baseFetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
	const now = options.now ?? (() => new Date());

	const headers = (extra?: Record<string, string>) => ({
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": APP_ID,
		...(options.token && { Authorization: `Bearer ${options.token}` }),
		...extra,
	});

	function rateLimitError(response: Response): GitHubRateLimitError | null {
		const remaining = response.headers.get("x-ratelimit-remaining");
		const retryAfter = Number(response.headers.get("retry-after"));
		// Secondary limits: 403/429 with retry-after while remaining > 0.
		if (
			(response.status === 403 || response.status === 429) &&
			retryAfter > 0
		) {
			return new GitHubRateLimitError(
				new Date(now().getTime() + retryAfter * 1000),
			);
		}
		if (
			response.status === 429 ||
			(response.status === 403 && remaining === "0")
		) {
			const reset = Number(response.headers.get("x-ratelimit-reset"));
			return new GitHubRateLimitError(
				Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null,
			);
		}
		return null;
	}

	/**
	 * GET JSON with caching. `immutable` entries never expire. Stale data is
	 * served (instead of failing) when GitHub is rate limited.
	 */
	async function getJson<T>(
		apiPath: string,
		{ immutable = false, cacheKey = apiPath } = {},
	): Promise<T> {
		const cached = await options.cache.get(cacheKey);
		const fresh =
			cached &&
			(immutable ||
				now().getTime() - cached.fetchedAt.getTime() < options.ttlMs);
		if (fresh) return cached.payload as T;

		let response: Response;
		try {
			response = await doFetch(`${options.apiUrl}${apiPath}`, {
				headers: headers(
					cached?.etag ? { "If-None-Match": cached.etag } : undefined,
				),
			});
		} catch (error) {
			// Network error or timeout: stale data beats no data.
			if (cached) return cached.payload as T;
			throw new GitHubError(
				coded("GITHUB_REQUEST_FAILED", { detail: networkErrorDetail(error) }),
				0,
			);
		}
		if (response.status === 304 && cached) {
			await options.cache.set(cacheKey, { ...cached, fetchedAt: now() });
			return cached.payload as T;
		}
		const limited = rateLimitError(response);
		if (limited) {
			if (cached) return cached.payload as T;
			throw limited;
		}
		if (response.status === 401) throw new GitHubAuthError();
		if (response.status >= 500 && cached) return cached.payload as T;
		if (!response.ok) {
			throw new GitHubError(
				coded("GITHUB_HTTP", { status: response.status, path: apiPath }),
				response.status,
			);
		}
		const payload = (await response.json()) as T;
		await options.cache.set(cacheKey, {
			etag: response.headers.get("etag"),
			payload,
			fetchedAt: now(),
		});
		return payload;
	}

	async function listReleases(repo: string): Promise<RawRelease[]> {
		return getJson<RawRelease[]>(`/repos/${repo}/releases?per_page=50`);
	}

	async function listTags(repo: string): Promise<RawTag[]> {
		return getJson<RawTag[]>(`/repos/${repo}/tags?per_page=100`);
	}

	async function listBranches(repo: string): Promise<RawBranch[]> {
		return getJson<RawBranch[]>(`/repos/${repo}/branches?per_page=100`);
	}

	async function listCommits(
		repo: string,
		ref?: string,
		dir?: string,
	): Promise<RawCommit[]> {
		const query = new URLSearchParams({ per_page: "30" });
		if (ref) query.set("sha", ref);
		if (dir) query.set("path", dir);
		return getJson<RawCommit[]>(`/repos/${repo}/commits?${query}`);
	}

	/** Resolve a tag/branch/SHA to the commit SHA and its root tree. */
	async function resolveCommit(
		repo: string,
		ref: string,
	): Promise<{ sha: string; tree: string }> {
		const isSha = /^[0-9a-f]{40}$/.test(ref);
		const commit = await getJson<{
			sha: string;
			commit: { tree: { sha: string } };
		}>(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
			immutable: isSha,
		});
		return { sha: commit.sha, tree: commit.commit.tree.sha };
	}

	async function getTree(repo: string, sha: string, recursive: boolean) {
		return getJson<RawTree>(
			`/repos/${repo}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`,
			{ immutable: true },
		);
	}

	/**
	 * Fetch every file under `dir` at `commitSha` (optionally only paths
	 * starting with one of `include`). Walks the path one tree at a time,
	 * refuses truncated listings, skips symlinks, rejects submodules,
	 * enforces limits before downloading and verifies each blob's SHA.
	 */
	async function fetchDirectory(
		repo: string,
		commitSha: string,
		rootTree: string,
		dir: string | undefined,
		include: string[],
		limits: FetchLimits,
	): Promise<{ files: FetchedFile[]; skipped: string[] }> {
		let treeSha = rootTree;
		const base = dir ? safeRelativePath(dir) : "";
		for (const segment of base ? base.split("/") : []) {
			const tree = await getTree(repo, treeSha, false);
			const entry = tree.tree.find((item) => item.path === segment);
			if (!entry || entry.type !== "tree") {
				throw new GitHubError(
					coded("GITHUB_DIR_NOT_FOUND", {
						dir: base,
						repo: `${repo}@${commitSha}`,
					}),
					404,
				);
			}
			treeSha = entry.sha;
		}

		const wanted = include.map((item) => safeRelativePath(item));
		const matches = (file: string) =>
			wanted.length === 0 ||
			wanted.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));

		// With `include`, only those paths are listed (one tree per segment,
		// then each included directory recursively): a recursive listing of a
		// large repo's root would be truncated.
		const entries: RawTreeEntry[] = [];
		const listRecursive = async (sha: string, prefix: string) => {
			const tree = await getTree(repo, sha, true);
			if (tree.truncated) {
				throw new GitHubError(
					coded("GITHUB_DIR_TRUNCATED", { dir: prefix || base }),
					0,
				);
			}
			for (const entry of tree.tree) {
				entries.push({
					...entry,
					path: prefix ? `${prefix}/${entry.path}` : entry.path,
				});
			}
		};
		if (wanted.length === 0) {
			await listRecursive(treeSha, "");
		} else {
			for (const item of wanted) {
				const segments = item.split("/");
				let sha = treeSha;
				let found: RawTreeEntry | undefined;
				for (const [index, segment] of segments.entries()) {
					const tree = await getTree(repo, sha, false);
					found = tree.tree.find((entry) => entry.path === segment);
					if (!found) break;
					if (index < segments.length - 1) {
						if (found.type !== "tree") {
							found = undefined;
							break;
						}
						sha = found.sha;
					}
				}
				if (!found) {
					throw new GitHubError(
						coded("GITHUB_ITEM_NOT_FOUND", {
							item,
							repo: `${repo}@${commitSha}`,
						}),
						404,
					);
				}
				if (found.type === "tree") await listRecursive(found.sha, item);
				else entries.push({ ...found, path: item });
			}
		}

		const skipped: string[] = [];
		const blobs: RawTreeEntry[] = [];
		for (const entry of entries) {
			const rel = safeRelativePath(entry.path);
			if (entry.type === "tree") continue;
			if (!matches(rel)) continue;
			if (entry.type === "commit" || entry.mode === "160000") {
				throw new GitHubError(coded("GITHUB_SUBMODULE", { path: rel }), 0);
			}
			if (entry.mode === "120000") {
				skipped.push(rel);
				continue;
			}
			if (entry.mode !== "100644" && entry.mode !== "100755") {
				throw new GitHubError(
					coded("GITHUB_FILE_MODE", { mode: String(entry.mode), path: rel }),
					0,
				);
			}
			blobs.push({ ...entry, path: rel });
		}

		if (blobs.length > limits.maxFiles) {
			throw new GitHubError(
				coded("GITHUB_TOO_MANY_FILES", {
					count: blobs.length,
					max: limits.maxFiles,
				}),
				0,
			);
		}
		const declared = blobs.reduce((sum, blob) => sum + (blob.size ?? 0), 0);
		if (declared > limits.maxBytes) {
			throw new GitHubError(
				coded("GITHUB_TOO_LARGE", {
					size: { $bytes: declared },
					max: { $bytes: limits.maxBytes },
				}),
				0,
			);
		}

		let total = 0;
		const files: FetchedFile[] = [];
		const queue = [...blobs];
		const worker = async () => {
			for (let blob = queue.shift(); blob; blob = queue.shift()) {
				const content = await fetchBlob(
					repo,
					commitSha,
					base,
					blob,
					limits.maxBytes,
				);
				total += content.length;
				if (total > limits.maxBytes) {
					throw new GitHubError(
						coded("GITHUB_TOO_LARGE_TOTAL", {
							max: { $bytes: limits.maxBytes },
						}),
						0,
					);
				}
				files.push({
					path: blob.path,
					content,
					executable: blob.mode === "100755",
				});
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(6, blobs.length) }, worker),
		);
		files.sort((a, b) => a.path.localeCompare(b.path));
		return { files, skipped };
	}

	/**
	 * Which of `paths` (relative to `dir`) are regular files at the commit:
	 * one cached tree listing per directory, nothing downloaded. Missing
	 * paths, directories and symlinks are left out.
	 */
	async function listFiles(
		repo: string,
		rootTree: string,
		dir: string | undefined,
		paths: string[],
	): Promise<Set<string>> {
		const base = dir ? safeRelativePath(dir) : "";
		const trees = new Map<string, Promise<RawTree | null>>();
		const treeOf = (folder: string): Promise<RawTree | null> => {
			let pending = trees.get(folder);
			if (!pending) {
				pending = (async () => {
					if (!folder) return getTree(repo, rootTree, false);
					const slash = folder.lastIndexOf("/");
					const parent = await treeOf(slash < 0 ? "" : folder.slice(0, slash));
					const name = folder.slice(slash + 1);
					const entry = parent?.tree.find((item) => item.path === name);
					return entry?.type === "tree"
						? getTree(repo, entry.sha, false)
						: null;
				})();
				trees.set(folder, pending);
			}
			return pending;
		};
		const files = new Set<string>();
		for (const item of paths) {
			const rel = safeRelativePath(item);
			const full = base ? `${base}/${rel}` : rel;
			const slash = full.lastIndexOf("/");
			const tree = await treeOf(slash < 0 ? "" : full.slice(0, slash));
			const entry = tree?.tree.find(
				(candidate) => candidate.path === full.slice(slash + 1),
			);
			if (
				entry?.type === "blob" &&
				(entry.mode === "100644" || entry.mode === "100755")
			) {
				files.add(rel);
			}
		}
		return files;
	}

	/**
	 * Content-addressed: cached by blob SHA, downloaded from raw at the
	 * commit SHA. Networks that block raw.githubusercontent.com but reach
	 * the API get the blob from the API instead (one request per file).
	 */
	async function fetchBlob(
		repo: string,
		commitSha: string,
		base: string,
		blob: RawTreeEntry,
		maxBytes: number,
	): Promise<Buffer> {
		const cacheKey = `blob:${blob.sha}`;
		const cached = await options.cache.get(cacheKey);
		if (cached && typeof cached.payload === "string") {
			return Buffer.from(cached.payload, "base64");
		}
		const filePath = base ? `${base}/${blob.path}` : blob.path;
		let response: Response | null = null;
		try {
			response = await doFetch(
				`${options.rawUrl}/${repo}/${commitSha}/${encodePath(filePath)}`,
				{ headers: { "User-Agent": APP_ID } },
			);
		} catch {
			// Unreachable raw host: the API below.
		}
		if (response && !response.ok) {
			throw new GitHubError(
				coded("GITHUB_DOWNLOAD_FAILED", {
					path: filePath,
					status: response.status,
				}),
				response.status,
			);
		}
		const content = response
			? Buffer.from(await response.arrayBuffer())
			: Buffer.from(
					(
						await getJson<{ content: string }>(
							`/repos/${repo}/git/blobs/${blob.sha}`,
							{ immutable: true },
						)
					).content,
					"base64",
				);
		if (
			content.length > maxBytes ||
			(blob.size !== undefined && content.length !== blob.size)
		) {
			throw new GitHubError(
				coded("GITHUB_SIZE_MISMATCH", { path: filePath }),
				0,
			);
		}
		if (gitBlobSha(content) !== blob.sha) {
			throw new GitHubError(
				coded("GITHUB_CHECKSUM_MISMATCH", { path: filePath }),
				0,
			);
		}
		await options.cache.set(cacheKey, {
			etag: null,
			payload: content.toString("base64"),
			fetchedAt: now(),
		});
		return content;
	}

	return {
		listReleases,
		listTags,
		listBranches,
		listCommits,
		resolveCommit,
		fetchDirectory,
		listFiles,
	};
}
