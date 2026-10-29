import { describe, expect, it, vi } from "vitest";
import {
	type CacheEntry,
	type CacheStore,
	createGitHubClient,
	GitHubAuthError,
	GitHubRateLimitError,
	gitBlobSha,
	safeRelativePath,
} from "./github";

function memoryCache(): CacheStore & { map: Map<string, CacheEntry> } {
	const map = new Map<string, CacheEntry>();
	return {
		map,
		get: async (key) => map.get(key) ?? null,
		set: async (key, entry) => {
			map.set(key, entry);
		},
	};
}

const json = (body: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", ...(init.headers ?? {}) },
		...init,
	});

function client(
	fetchImpl: typeof fetch,
	cache = memoryCache(),
	now = new Date(),
) {
	return {
		cache,
		gh: createGitHubClient({
			apiUrl: "https://api.test",
			rawUrl: "https://raw.test",
			token: "tok",
			cache,
			ttlMs: 60_000,
			fetch: fetchImpl,
			now: () => now,
		}),
	};
}

describe("caching", () => {
	it("serves fresh cache, revalidates stale entries with ETag", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				json([{ name: "v1", commit: { sha: "a" } }], {
					headers: { etag: '"e1"' },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 304 }));
		let now = new Date("2026-01-01T00:00:00Z");
		const cache = memoryCache();
		const gh = createGitHubClient({
			apiUrl: "https://api.test",
			rawUrl: "https://raw.test",
			cache,
			ttlMs: 1000,
			fetch: fetchMock,
			now: () => now,
		});
		expect(await gh.listTags("o/r")).toHaveLength(1);
		expect(await gh.listTags("o/r")).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		now = new Date(now.getTime() + 5000);
		expect(await gh.listTags("o/r")).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const headers = fetchMock.mock.calls[1][1]?.headers as Record<
			string,
			string
		>;
		expect(headers["If-None-Match"]).toBe('"e1"');
	});

	it("raises a rate-limit error with reset time, or serves stale data", async () => {
		const limited = () =>
			new Response("{}", {
				status: 403,
				headers: {
					"x-ratelimit-remaining": "0",
					"x-ratelimit-reset": "1800000000",
				},
			});
		const { gh } = client(vi.fn<typeof fetch>().mockResolvedValue(limited()));
		const error = await gh.listReleases("o/r").catch((e) => e);
		expect(error).toBeInstanceOf(GitHubRateLimitError);
		expect(error.resetAt.toISOString()).toBe("2027-01-15T08:00:00.000Z");

		const cache = memoryCache();
		cache.map.set("/repos/o/r/releases?per_page=50", {
			etag: null,
			payload: [{ tag_name: "v1" }],
			fetchedAt: new Date(0),
		});
		const stale = client(
			vi.fn<typeof fetch>().mockResolvedValue(limited()),
			cache,
		);
		expect(await stale.gh.listReleases("o/r")).toEqual([{ tag_name: "v1" }]);
	});

	it("sends the token", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json([]));
		await client(fetchMock).gh.listTags("o/r");
		const headers = fetchMock.mock.calls[0][1]?.headers as Record<
			string,
			string
		>;
		expect(headers.Authorization).toBe("Bearer tok");
	});
});

describe("fetchDirectory", () => {
	const compose = Buffer.from("services: {}\n");
	const env = Buffer.from("A=1\n");
	const routes: Record<string, unknown> = {
		"https://api.test/repos/o/r/git/trees/root": {
			sha: "root",
			truncated: false,
			tree: [
				{ path: "docker", type: "tree", mode: "040000", sha: "dockertree" },
			],
		},
		"https://api.test/repos/o/r/git/trees/dockertree?recursive=1": {
			sha: "dockertree",
			truncated: false,
			tree: [
				{
					path: "docker-compose.yml",
					type: "blob",
					mode: "100644",
					sha: gitBlobSha(compose),
					size: compose.length,
				},
				{ path: "volumes", type: "tree", mode: "040000", sha: "v" },
				{
					path: "volumes/.env",
					type: "blob",
					mode: "100755",
					sha: gitBlobSha(env),
					size: env.length,
				},
				{
					path: "volumes/link",
					type: "blob",
					mode: "120000",
					sha: "l",
					size: 3,
				},
				{
					path: "tests/big.bin",
					type: "blob",
					mode: "100644",
					sha: "x",
					size: 999999,
				},
			],
		},
	};
	const raw: Record<string, Buffer> = {
		"https://raw.test/o/r/c0ffee/docker/docker-compose.yml": compose,
		"https://raw.test/o/r/c0ffee/docker/volumes/.env": env,
	};
	// Includes are listed one tree at a time: derive the non-recursive
	// trees of "docker" and the recursive tree of "volumes" from the full one.
	const full = routes[
		"https://api.test/repos/o/r/git/trees/dockertree?recursive=1"
	] as { tree: { path: string; sha: string; type: string }[] };
	routes["https://api.test/repos/o/r/git/trees/dockertree"] = {
		sha: "dockertree",
		truncated: false,
		tree: full.tree.filter((entry) => !entry.path.includes("/")),
	};
	routes["https://api.test/repos/o/r/git/trees/v?recursive=1"] = {
		sha: "v",
		truncated: false,
		tree: full.tree
			.filter((entry) => entry.path.startsWith("volumes/"))
			.map((entry) => ({ ...entry, path: entry.path.slice(8) })),
	};
	const fetchImpl: typeof fetch = async (input) => {
		const url = String(input);
		if (url in routes) return json(routes[url]);
		if (url in raw) return new Response(new Uint8Array(raw[url]));
		return new Response("nope", { status: 404 });
	};

	it("walks the path, filters includes, skips symlinks and verifies blobs", async () => {
		const { gh, cache } = client(fetchImpl);
		const result = await gh.fetchDirectory(
			"o/r",
			"c0ffee",
			"root",
			"docker",
			["docker-compose.yml", "volumes"],
			{
				maxFiles: 10,
				maxBytes: 1000,
			},
		);
		expect(result.files.map((f) => [f.path, f.executable])).toEqual([
			["docker-compose.yml", false],
			["volumes/.env", true],
		]);
		expect(result.skipped).toEqual(["volumes/link"]);
		expect(cache.map.has(`blob:${gitBlobSha(compose)}`)).toBe(true);
	});

	it("gets blobs from the API when the raw host is unreachable", async () => {
		const byApi = new Map(
			[compose, env].map((content) => [
				`https://api.test/repos/o/r/git/blobs/${gitBlobSha(content)}`,
				content,
			]),
		);
		const blocked: typeof fetch = async (input) => {
			const url = String(input);
			if (url.startsWith("https://raw.test")) {
				throw new TypeError("fetch failed", {
					cause: { code: "ENOTFOUND" },
				});
			}
			const content = byApi.get(url);
			if (content) return json({ content: content.toString("base64") });
			return fetchImpl(input);
		};
		const result = await client(blocked).gh.fetchDirectory(
			"o/r",
			"c0ffee",
			"root",
			"docker",
			["docker-compose.yml", "volumes"],
			{ maxFiles: 10, maxBytes: 1000 },
		);
		expect(result.files.map((f) => f.content.toString())).toEqual([
			compose.toString(),
			env.toString(),
		]);
		// Unreachable both ways: the network error, with its reason.
		const offline: typeof fetch = async (input) =>
			String(input).includes("/git/blobs/") ||
			String(input).startsWith("https://raw.test")
				? Promise.reject(
						new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }),
					)
				: fetchImpl(input);
		await expect(
			client(offline).gh.fetchDirectory(
				"o/r",
				"c0ffee",
				"root",
				"docker",
				["docker-compose.yml"],
				{ maxFiles: 10, maxBytes: 1000 },
			),
		).rejects.toThrow(/fetch failed \(ENOTFOUND\)/);
	});

	it("enforces limits from declared sizes before downloading", async () => {
		const { gh } = client(fetchImpl);
		await expect(
			gh.fetchDirectory("o/r", "c0ffee", "root", "docker", [], {
				maxFiles: 10,
				maxBytes: 1000,
			}),
		).rejects.toThrow(/limit 1000/);
		await expect(
			gh.fetchDirectory(
				"o/r",
				"c0ffee",
				"root",
				"docker",
				["docker-compose.yml", "volumes"],
				{
					maxFiles: 1,
					maxBytes: 1000,
				},
			),
		).rejects.toThrow(/limit 1/);
	});

	it("rejects tampered content, truncated trees and missing dirs", async () => {
		const tampered: typeof fetch = async (input) =>
			String(input).startsWith("https://raw.test")
				? new Response("services: []\n")
				: fetchImpl(input);
		await expect(
			client(tampered).gh.fetchDirectory(
				"o/r",
				"c0ffee",
				"root",
				"docker",
				["docker-compose.yml"],
				{
					maxFiles: 10,
					maxBytes: 1000,
				},
			),
		).rejects.toThrow(/Checksum mismatch/);

		const truncated: typeof fetch = async (input) =>
			String(input).includes("recursive")
				? json({ sha: "d", truncated: true, tree: [] })
				: fetchImpl(input);
		await expect(
			client(truncated).gh.fetchDirectory(
				"o/r",
				"c0ffee",
				"root",
				"docker",
				[],
				{ maxFiles: 10, maxBytes: 1000 },
			),
		).rejects.toThrow(/truncated/);

		await expect(
			client(fetchImpl).gh.fetchDirectory("o/r", "c0ffee", "root", "nope", [], {
				maxFiles: 10,
				maxBytes: 1000,
			}),
		).rejects.toThrow(/not found/);
	});
});

describe("safeRelativePath / gitBlobSha", () => {
	it.each([
		"../x",
		"/etc/passwd",
		"a/../../b",
		"a\\b",
		"a//b",
		"./a",
		"",
	])("rejects %j", (p) => {
		expect(() => safeRelativePath(p)).toThrow();
	});

	it("matches git's blob id", () => {
		// `printf 'hello\n' | git hash-object --stdin`
		expect(gitBlobSha(Buffer.from("hello\n"))).toBe(
			"ce013625030ba8dba906f756967f9e9ca394464a",
		);
	});
});

describe("resilience", () => {
	const stale = () => {
		const cache = memoryCache();
		cache.map.set("/repos/o/r/tags?per_page=100", {
			etag: null,
			payload: [{ name: "v1" }],
			fetchedAt: new Date(0),
		});
		return cache;
	};

	it("treats secondary rate limits (retry-after) as rate limits", async () => {
		const response = () =>
			new Response("{}", {
				status: 403,
				headers: { "retry-after": "60", "x-ratelimit-remaining": "10" },
			});
		await expect(
			client(vi.fn<typeof fetch>().mockResolvedValue(response())).gh.listTags(
				"o/r",
			),
		).rejects.toBeInstanceOf(GitHubRateLimitError);
		expect(
			await client(
				vi.fn<typeof fetch>().mockResolvedValue(response()),
				stale(),
			).gh.listTags("o/r"),
		).toEqual([{ name: "v1" }]);
	});

	it("serves stale data on 5xx and network errors, and times out", async () => {
		expect(
			await client(
				vi
					.fn<typeof fetch>()
					.mockResolvedValue(new Response("", { status: 502 })),
				stale(),
			).gh.listTags("o/r"),
		).toEqual([{ name: "v1" }]);
		expect(
			await client(
				vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")),
				stale(),
			).gh.listTags("o/r"),
		).toEqual([{ name: "v1" }]);
		const hanging: typeof fetch = (_input, init) =>
			new Promise((_, reject) =>
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				),
			);
		const gh = createGitHubClient({
			apiUrl: "https://api.test",
			rawUrl: "https://raw.test",
			cache: memoryCache(),
			ttlMs: 0,
			fetch: hanging,
			timeoutMs: 50,
		});
		await expect(gh.listTags("o/r")).rejects.toThrow(/request failed/);
	});

	it("maps 401 to an invalid token error", async () => {
		await expect(
			client(
				vi
					.fn<typeof fetch>()
					.mockResolvedValue(new Response("", { status: 401 })),
			).gh.listTags("o/r"),
		).rejects.toBeInstanceOf(GitHubAuthError);
	});
});

describe("listFiles", () => {
	it("tells which paths are regular files upstream, one tree per folder", async () => {
		const trees: Record<string, unknown> = {
			root: {
				sha: "root",
				truncated: false,
				tree: [{ path: "docker", mode: "040000", type: "tree", sha: "docker" }],
			},
			docker: {
				sha: "docker",
				truncated: false,
				tree: [
					{ path: "init.sh", mode: "100755", type: "blob", sha: "b1" },
					{ path: "link.xml", mode: "120000", type: "blob", sha: "b2" },
					{ path: "volumes", mode: "040000", type: "tree", sha: "volumes" },
				],
			},
			volumes: {
				sha: "volumes",
				truncated: false,
				tree: [
					{ path: "data", mode: "040000", type: "tree", sha: "data" },
					{ path: "kong.yml", mode: "100644", type: "blob", sha: "b3" },
				],
			},
		};
		const fetchMock = vi.fn<typeof fetch>(async (url) => {
			const sha = String(url).match(/git\/trees\/([^?]+)/)?.[1] ?? "";
			return json(trees[sha]);
		});
		const files = await client(fetchMock).gh.listFiles(
			"o/r",
			"root",
			"docker",
			[
				"init.sh",
				"link.xml",
				"missing.conf",
				"volumes/data",
				"volumes/kong.yml",
				"nowhere/x.yml",
			],
		);
		expect([...files]).toEqual(["init.sh", "volumes/kong.yml"]);
		// root, docker, volumes (cached; `nowhere` is not a folder upstream).
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
