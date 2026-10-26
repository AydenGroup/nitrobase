import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import textSamples from "#/__fixtures__/text-samples.json";
import { shellQuote as q } from "#/server/services/executor.ts";
import {
	assertFunctionFilePath,
	assertFunctionFiles,
	assertFunctionName,
	assertNewSharedFolderName,
	assertSharedFolderName,
	buildTar,
	classifyFolder,
	deleteFunctionCommand,
	deployFunctionScript,
	foldersScript,
	functionListScript,
	listFoldersCommand,
	listFunctionsCommand,
	parseFolderList,
	parseFunctionList,
	parseTar,
	readFunctionCommand,
} from "./edge-functions";

const limits = { maxFiles: 10, maxBytes: 10_000 };

describe("assertFunctionName", () => {
	it.each(["hello", "hello-world", "a_b2", "x"])("accepts %s", (name) => {
		expect(assertFunctionName(name)).toBe(name);
	});

	it.each([
		"",
		"Hello",
		"1abc",
		"-x",
		"a/b",
		"..",
		".hidden",
		"a b",
		"a;rm -rf",
		"$(id)",
		"a".repeat(64),
	])("rejects %j", (name) => {
		expect(() => assertFunctionName(name)).toThrow();
	});

	it("rejects reserved names", () => {
		expect(() => assertFunctionName("main", ["main"])).toThrow(/reserved/);
	});
});

describe("assertFunctionFilePath", () => {
	it.each([
		"index.ts",
		"deno.json",
		"lib/cors.ts",
		"a/b/c.ts",
	])("accepts %s", (file) => {
		expect(assertFunctionFilePath(file)).toBe(file);
	});

	it.each([
		"",
		"/etc/passwd",
		"../x.ts",
		"a/../b.ts",
		"./a.ts",
		"a//b.ts",
		".env",
		"a/.git/config",
		"a/",
		"a\\b",
	])("rejects %j", (file) => {
		expect(() => assertFunctionFilePath(file)).toThrow();
	});
});

describe("assertFunctionFiles", () => {
	it("enforces limits, duplicates and file/dir clashes", () => {
		expect(() => assertFunctionFiles([], limits)).toThrow();
		expect(() =>
			assertFunctionFiles(
				[
					{ path: "a.ts", content: "" },
					{ path: "a.ts", content: "" },
				],
				limits,
			),
		).toThrow(/Duplicate/);
		expect(() =>
			assertFunctionFiles(
				[
					{ path: "lib", content: "" },
					{ path: "lib/x.ts", content: "" },
				],
				limits,
			),
		).toThrow(/conflicts/);
		expect(() =>
			assertFunctionFiles(
				[{ path: "a.ts", content: "x".repeat(10_001) }],
				limits,
			),
		).toThrow(/exceeds/);
	});
});

describe("tar", () => {
	const files = [
		{
			path: "index.ts",
			content: `Deno.serve(() => new Response(${JSON.stringify(textSamples.samples)}));\n`,
		},
		{ path: "lib/cors.ts", content: "export const x = 1;\n" },
	];

	it("builds a deterministic ustar archive under the root", () => {
		const tar = buildTar(
			".nitrobase-staging-hello-abcd1234",
			files,
			1700000000,
		);
		expect(tar.length % 512).toBe(0);
		expect(tar.subarray(0, 100).toString("utf8").replace(/\0+$/, "")).toBe(
			".nitrobase-staging-hello-abcd1234/",
		);
		expect(tar.subarray(257, 263).toString("latin1")).toBe("ustar\0");
		expect(
			buildTar(".nitrobase-staging-hello-abcd1234", files, 1700000000),
		).toEqual(tar);
		// Checksum field is valid.
		const header = Buffer.from(tar.subarray(0, 512));
		const stored = Number.parseInt(header.subarray(148, 154).toString(), 8);
		header.fill(" ", 148, 156);
		expect(header.reduce((sum, byte) => sum + byte, 0)).toBe(stored);
	});

	it("round-trips through parseTar (as docker cp returns it)", () => {
		const tar = buildTar(".", files, 1700000000);
		const parsed = parseTar(tar, limits);
		expect(parsed.skipped).toEqual([]);
		expect(parsed.files).toEqual(files);
	});

	it("uses the ustar prefix for long paths", () => {
		const long = `${"d".repeat(90)}/${"f".repeat(60)}.ts`;
		const tar = buildTar("root", [{ path: long, content: "x" }], 1);
		expect(parseTar(tar, limits).files[0].path).toBe(`root/${long}`);
	});

	it("skips symlinks and unsafe names, enforces limits", () => {
		const tar = buildTar(".", [{ path: "index.ts", content: "ok" }], 1);
		// Turn the file entry (second header) into a symlink.
		const linked = Buffer.from(tar);
		const second = 512;
		linked[second + 156] = "2".charCodeAt(0);
		expect(parseTar(linked, limits)).toEqual({
			files: [],
			skipped: ["index.ts"],
		});
		expect(() =>
			parseTar(buildTar(".", [{ path: "a.ts", content: "x".repeat(50) }], 1), {
				maxFiles: 10,
				maxBytes: 10,
			}),
		).toThrow(/limits/);
	});
});

describe("commands", () => {
	const container = "supabase-0123abcd-functions";
	const dir = "/home/deno/functions";

	it("lists through the container", () => {
		expect(listFunctionsCommand(container, dir)).toBe(
			[
				`[ "$(docker inspect -f '{{.State.Running}}' 'supabase-0123abcd-functions' 2>/dev/null)" = true ] || { echo "Container is not running" >&2; exit 96; }`,
				`docker exec 'supabase-0123abcd-functions' sh -c ${q(functionListScript(dir))}`,
			].join("\n"),
		);
	});

	it("lists with POSIX tools only (no GNU find -printf)", () => {
		expect(functionListScript(dir)).not.toContain("-printf");
		expect(foldersScript(dir, ["index.ts"])).not.toContain("-printf");
	});

	it("reads with docker cp to stdout", () => {
		expect(readFunctionCommand(container, dir, "hello")).toBe(
			"docker cp 'supabase-0123abcd-functions:/home/deno/functions/hello/.' - | base64",
		);
	});

	it("deploys via docker cp of stdin + an in-container swap", () => {
		expect(
			deployFunctionScript(
				container,
				dir,
				"hello",
				".nitrobase-staging-hello-abcd1234",
			),
		).toBe(
			[
				"set -e",
				`[ "$(docker inspect -f '{{.State.Running}}' 'supabase-0123abcd-functions' 2>/dev/null)" = true ] || { echo "Container is not running" >&2; exit 96; }`,
				"docker cp - 'supabase-0123abcd-functions:/home/deno/functions'",
				`docker exec 'supabase-0123abcd-functions' sh -c 'cd "$1" && rm -rf -- "$2" && mv -T -- "$3" "$2"' sh '/home/deno/functions' 'hello' '.nitrobase-staging-hello-abcd1234'`,
			].join("\n"),
		);
	});

	it("deletes inside the container", () => {
		expect(deleteFunctionCommand(container, dir, "hello").split("\n")[1]).toBe(
			"docker exec 'supabase-0123abcd-functions' rm -rf -- '/home/deno/functions/hello'",
		);
	});

	it("never accepts unsafe parts", () => {
		expect(() => readFunctionCommand(container, dir, "../x")).toThrow();
		expect(() => deleteFunctionCommand("x;id", dir, "hello")).toThrow();
		expect(() =>
			deleteFunctionCommand(container, "/home/../etc", "a"),
		).toThrow();
		expect(() =>
			deployFunctionScript(container, dir, "hello", "../../etc"),
		).toThrow();
	});
});

describe("parseFunctionList", () => {
	it("keeps valid, non-hidden names sorted", () => {
		expect(
			parseFunctionList(
				"main\t1700000000.5\nzeta\t1700000000\nalpha\t1700000000\nBad Name\t1\n",
				["main"],
			),
		).toEqual([
			{ name: "alpha", updatedAt: "2023-11-14T22:13:20.000Z" },
			{ name: "zeta", updatedAt: "2023-11-14T22:13:20.000Z" },
		]);
	});
});

describe("shared folders", () => {
	const container = "supabase-0123abcd-functions";
	const dir = "/home/deno/functions";

	describe("classifyFolder", () => {
		const known = { reserved: ["main"], entrypointsKnown: true };

		it.each([
			["_shared", false, "shared"],
			["_utils", true, "shared"],
			["watch", true, "function"],
			["lib", false, "shared"],
			["main", true, null],
			["Bad Name", true, null],
			[".hidden", false, null],
		] as const)("%s (entrypoint %s) -> %s", (name, hasEntry, kind) => {
			expect(classifyFolder(name, hasEntry, known)).toBe(kind);
		});

		it("keeps a folder without an entrypoint a function when the template names none", () => {
			expect(
				classifyFolder("lib", false, { reserved: [], entrypointsKnown: false }),
			).toBe("function");
		});
	});

	describe("parseFolderList", () => {
		it("splits functions from shared folders and ignores the rest", () => {
			const output =
				"watch\t1700000000\t1\n_shared\t1700000000.5\t0\nlib\t1700000000\t0\nmain\t1\t1\nBad Name\t1\t1\nhello\t1700000000\t1\n";
			const list = parseFolderList(output, {
				reserved: ["main"],
				entrypointsKnown: true,
			});
			expect(Object.fromEntries(list.map((f) => [f.name, f.kind]))).toEqual({
				_shared: "shared",
				hello: "function",
				lib: "shared",
				watch: "function",
			});
			expect(list.find((f) => f.name === "hello")?.updatedAt).toBe(
				"2023-11-14T22:13:20.000Z",
			);
		});
	});

	describe("names", () => {
		it.each([
			"_shared",
			"_utils",
			"_a1",
			"lib",
			"common",
		])("assertSharedFolderName accepts %s", (name) => {
			expect(assertSharedFolderName(name)).toBe(name);
		});

		it.each([
			"",
			"_",
			".",
			"..",
			"a/b",
			"../x",
			"A",
			"a b",
			"-x",
			"$(id)",
		])("assertSharedFolderName rejects %j", (name) => {
			expect(() => assertSharedFolderName(name)).toThrow();
		});

		it("assertSharedFolderName rejects reserved names", () => {
			expect(() => assertSharedFolderName("main", ["main"])).toThrow(
				/reserved/,
			);
		});

		it.each([
			"_shared",
			"_utils",
			"_a1",
		])("assertNewSharedFolderName accepts %s", (name) => {
			expect(assertNewSharedFolderName(name)).toBe(name);
		});

		it.each([
			"lib",
			"shared",
			"_",
			"_-x",
			"_A",
			"main",
			"_a/b",
		])("assertNewSharedFolderName rejects %j", (name) => {
			expect(() => assertNewSharedFolderName(name)).toThrow();
		});
	});

	describe("read / deploy / delete commands", () => {
		it("reads a shared folder by an underscore or plain name", () => {
			expect(
				readFunctionCommand(container, dir, "_shared", { shared: true }),
			).toBe(
				"docker cp 'supabase-0123abcd-functions:/home/deno/functions/_shared/.' - | base64",
			);
			expect(
				readFunctionCommand(container, dir, "lib", { shared: true }),
			).toContain("/home/deno/functions/lib/.");
			expect(() =>
				readFunctionCommand(container, dir, "../x", { shared: true }),
			).toThrow();
		});

		it("deploys a shared folder", () => {
			expect(
				deployFunctionScript(
					container,
					dir,
					"_shared",
					".nitrobase-staging-s-abcd1234",
					{ shared: true },
				),
			).toContain(
				"sh '/home/deno/functions' '_shared' '.nitrobase-staging-s-abcd1234'",
			);
		});

		it("deletes a shared folder inside the container", () => {
			expect(
				deleteFunctionCommand(container, dir, "_shared", {
					shared: true,
				}).split("\n")[1],
			).toBe(
				"docker exec 'supabase-0123abcd-functions' rm -rf -- '/home/deno/functions/_shared'",
			);
		});

		it.each([
			"",
			".",
			"..",
			"a/b",
			"_",
			"../x",
			"a;id",
		])("never builds a delete command for %j", (name) => {
			expect(() =>
				deleteFunctionCommand(container, dir, name, { shared: true }),
			).toThrow();
		});

		it("keeps rejecting underscore names for plain functions", () => {
			expect(() => deleteFunctionCommand(container, dir, "_shared")).toThrow();
		});
	});

	describe("listFoldersCommand", () => {
		it("guards the container and lists through docker exec", () => {
			const lines = listFoldersCommand(container, dir, ["index.ts"]).split(
				"\n",
			);
			expect(lines[0]).toContain("Container is not running");
			expect(lines[1]).toMatch(
				/^docker exec 'supabase-0123abcd-functions' sh -c /,
			);
		});

		it("rejects unsafe entrypoint names", () => {
			expect(() =>
				listFoldersCommand(container, dir, ["a;rm -rf /"]),
			).toThrow();
			expect(() => listFoldersCommand(container, dir, ['x"y'])).toThrow();
		});
	});

	describe.skipIf(process.platform === "win32")(
		"foldersScript (real sh)",
		() => {
			const run = (root: string, entrypoints: string[]) =>
				Object.fromEntries(
					execFileSync("sh", ["-c", foldersScript(root, entrypoints)])
						.toString()
						.trim()
						.split("\n")
						.map((line) => {
							const [name, , entry] = line.split("\t");
							return [name, entry];
						}),
				);

			it("reports every visible folder and whether it has an entrypoint", () => {
				const root = mkdtempSync(path.join(os.tmpdir(), "folders-"));
				try {
					for (const [folder, file] of [
						["watch", "index.ts"],
						["_shared", "util.ts"],
						["lib", "x.js"],
						["tsfn", "index.tsx"],
					]) {
						mkdirSync(path.join(root, folder));
						writeFileSync(path.join(root, folder, file), "x");
					}
					mkdirSync(path.join(root, ".nitrobase-staging-x"));
					expect(run(root, ["index.ts", "index.js", "index.tsx"])).toEqual({
						watch: "1",
						_shared: "0",
						lib: "0",
						tsfn: "1",
					});
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			});

			it("lists function folders with their mtime in epoch seconds", () => {
				const root = mkdtempSync(path.join(os.tmpdir(), "functions-"));
				try {
					mkdirSync(path.join(root, "hello"));
					mkdirSync(path.join(root, "with space"));
					mkdirSync(path.join(root, ".nitrobase-staging-x"));
					writeFileSync(path.join(root, "file.ts"), "x");
					symlinkSync(path.join(root, "hello"), path.join(root, "link"));
					const rows = execFileSync("sh", ["-c", functionListScript(root)])
						.toString()
						.trim()
						.split("\n")
						.map((line) => line.split("\t"));
					expect(rows.map(([name]) => name).sort()).toEqual([
						"hello",
						"with space",
					]);
					const now = Date.now() / 1000;
					for (const [, mtime] of rows) {
						expect(Math.abs(Number(mtime) - now)).toBeLessThan(600);
					}
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			});

			it("prints nothing for an empty folder", () => {
				const root = mkdtempSync(path.join(os.tmpdir(), "functions-"));
				try {
					expect(
						execFileSync("sh", ["-c", functionListScript(root)]).toString(),
					).toBe("");
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			});

			it("marks every folder 0 when no entrypoint names are given", () => {
				const root = mkdtempSync(path.join(os.tmpdir(), "folders-"));
				try {
					mkdirSync(path.join(root, "watch"));
					writeFileSync(path.join(root, "watch", "index.ts"), "x");
					expect(run(root, [])).toEqual({ watch: "0" });
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			});
		},
	);

	describe("nested files", () => {
		const files = [
			{ path: "adapters/okx.js", content: "a" },
			{ path: "core/analysis.js", content: "b" },
			{ path: "core/zones.js", content: "c" },
		];

		it("pass the file checks", () => {
			expect(assertFunctionFiles(files, limits)).toEqual(files);
		});

		it("keep their paths through a tar round trip", () => {
			const parsed = parseTar(buildTar(".", files), limits);
			expect(parsed.files.map((f) => f.path).sort()).toEqual(
				files.map((f) => f.path),
			);
			expect(parsed.skipped).toEqual([]);
		});
	});
});
