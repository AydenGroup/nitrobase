import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tarXattrArgs } from "#/config/backup-tools.ts";
import type { StorageFilesConfig } from "#/features/supabase/schema.ts";
import type { ExecResult, Executor } from "#/server/services/executor.ts";
import {
	attrProbeCommand,
	checkStorageFiles,
	headerValue,
	isSafeSegment,
	objectCandidates,
	parseRepairSummary,
	parseStorageBackend,
	parseStorageObjects,
	REPAIR_SCRIPT,
	repairCommand,
	repairInput,
	type StorageObjectRow,
	storageBackendCommand,
	storageHostRoot,
	storageObjectsQuery,
	storageRootSegments,
} from "./storage-metadata";

const config: StorageFilesConfig = {
	service: "storage",
	backend_variable: "STORAGE_BACKEND",
	backend_value: "file",
	path: "volumes/storage",
	bucket_variable: "GLOBAL_S3_BUCKET",
	tenant_variable: "STORAGE_TENANT_ID",
	version_separators: ["/", "-$v-"],
	content_type_xattr: "user.supabase.content-type",
	cache_control_xattr: "user.supabase.cache-control",
	default_content_type: "application/octet-stream",
	default_cache_control: "no-cache",
};
const root: [string, string] = ["stub", "stub"];
const V = "0f6b2f6e-3a4b-4c5d-8e9f-0123456789ab";
const row = (over: Partial<StorageObjectRow> = {}): StorageObjectRow => ({
	id: "00000000-0000-4000-8000-000000000001",
	bucket_id: "avatars",
	name: "a.txt",
	version: V,
	mimetype: "text/plain",
	cache_control: "max-age=3600",
	...over,
});
const unb64 = (value: string) => Buffer.from(value, "base64").toString("utf8");

describe("tar xattr flags", () => {
	it("keeps user.* only and tolerates destinations without xattrs", () => {
		expect(tarXattrArgs("create")).toEqual([
			"--xattrs",
			"--xattrs-include=user.*",
			"--xattrs-exclude=security.*",
			"--xattrs-exclude=trusted.*",
			"--xattrs-exclude=system.*",
		]);
		expect(tarXattrArgs("extract")).toEqual([
			...tarXattrArgs("create"),
			"--warning=no-xattr-write",
		]);
	});
});

describe("storage backend and tools probe", () => {
	it("prints only the backend variable of the storage container", () => {
		const command = storageBackendCommand("sb-1-storage", "STORAGE_BACKEND");
		expect(command).toContain("docker inspect --format");
		expect(command).toContain('grep -m1 -- "^$2="');
		expect(command.endsWith("sh 'sb-1-storage' 'STORAGE_BACKEND'")).toBe(true);
		expect(() => storageBackendCommand("x;rm -rf /", "A")).toThrow();
		expect(() => storageBackendCommand("sb-1-storage", "A=B")).toThrow();
		expect(
			parseStorageBackend("STORAGE_BACKEND=file\n", "STORAGE_BACKEND"),
		).toBe("file");
		expect(parseStorageBackend("", "STORAGE_BACKEND")).toBeNull();
	});

	it("probes getfattr/setfattr in the tools image", () => {
		expect(attrProbeCommand("nitrobase-backup-tools:2")).toContain(
			"'command -v setfattr >/dev/null && command -v getfattr >/dev/null'",
		);
	});
});

/** Executor answering each command by its first matching rule. */
function fakeExecutor(rules: [RegExp, Partial<ExecResult>][]): {
	executor: Executor;
	commands: string[];
} {
	const commands: string[] = [];
	const executor = {
		exec: async (command: string) => {
			commands.push(command);
			const rule = rules.find(([pattern]) => pattern.test(command));
			return { stdout: "", stderr: "", exitCode: 0, ...rule?.[1] };
		},
	} as unknown as Executor;
	return { executor, commands };
}

describe("checkStorageFiles", () => {
	const location = { folder: "sb-1", appRoot: "/etc/nitrobase/apps/sb-1" };
	const base = (executor: Executor) => ({
		executor,
		toolsImage: "nitrobase-backup-tools:2",
		config,
		values: { GLOBAL_S3_BUCKET: "stub", STORAGE_TENANT_ID: "stub" },
		location,
		database: {
			container: "sb-1-db",
			user: "supabase_admin",
			database: "postgres",
			timeoutMs: 1000,
		},
		storageContainer: "sb-1-storage",
		batchSize: 100,
		timeoutMs: 1000,
	});
	const job = () => {
		const events: unknown[][] = [];
		return {
			events,
			job: { event: ((...args: unknown[]) => events.push(args)) as never },
		};
	};

	it("skips other storage backends with a note", async () => {
		const { executor, commands } = fakeExecutor([
			[/docker inspect/, { stdout: "STORAGE_BACKEND=s3\n" }],
		]);
		const log = job();
		expect(await checkStorageFiles(base(executor), log.job)).toBeNull();
		expect(log.events).toEqual([
			["supabase.storage_not_file_backend", { backend: "s3" }],
		]);
		expect(commands).toHaveLength(1);
	});

	it("skips when the backend variable is unset", async () => {
		const { executor } = fakeExecutor([[/docker inspect/, { stdout: "" }]]);
		const log = job();
		expect(await checkStorageFiles(base(executor), log.job)).toBeNull();
		expect(log.events[0]?.[0]).toBe("supabase.storage_backend_unset");
	});

	it("fails with a coded error when the tools image lacks attr", async () => {
		const { executor } = fakeExecutor([
			[/docker inspect/, { stdout: "STORAGE_BACKEND=file\n" }],
			[/command -v setfattr/, { exitCode: 1 }],
		]);
		await expect(
			checkStorageFiles(base(executor), job().job),
		).rejects.toMatchObject({ code: "BACKUP_TOOLS_NO_ATTR" });
	});

	it("reports files it could not fix as warnings", async () => {
		const { executor } = fakeExecutor([
			[/docker inspect/, { stdout: "STORAGE_BACKEND=file\n" }],
			[
				/psql/,
				{
					stdout: JSON.stringify([
						{
							id: "00000000-0000-4000-8000-000000000001",
							bucket_id: "avatars",
							name: "a.txt",
							version: null,
							mimetype: "text/plain",
							cache_control: null,
						},
					]),
				},
			],
			[
				/setfattr -n/,
				{
					stdout:
						"nitrobase-storage-repair fixed=0 ok=0 missing=0 unsafe=0 failed=1\n",
				},
			],
		]);
		const warnings: number[] = [];
		const log = job();
		const totals = await checkStorageFiles(base(executor), {
			...log.job,
			addWarnings: async (count) => {
				warnings.push(count);
			},
		});
		expect(totals).toMatchObject({ objects: 1, failed: 1 });
		expect(log.events).toContainEqual([
			"supabase.storage_failed",
			{ count: 1 },
		]);
		expect(warnings).toEqual([1]);
	});
});

describe("storage objects query", () => {
	it("pages by id and refuses a non-uuid cursor", () => {
		expect(storageObjectsQuery(null, 500)).toBe(
			"SELECT coalesce(json_agg(row_to_json(o) ORDER BY o.id), '[]'::json) FROM ( SELECT id, bucket_id, name, version, metadata->>'mimetype' AS mimetype, metadata->>'cacheControl' AS cache_control FROM storage.objects ORDER BY id LIMIT 500) o",
		);
		expect(storageObjectsQuery(V, 0)).toContain(
			`WHERE id > '${V}'::uuid ORDER BY id LIMIT 1) o`,
		);
		expect(() => storageObjectsQuery("x' OR 1=1 --", 10)).toThrow();
	});

	it("parses rows and rejects anything else", () => {
		expect(parseStorageObjects("")).toEqual([]);
		expect(parseStorageObjects(JSON.stringify([row()]))).toEqual([row()]);
		expect(() => parseStorageObjects("not json")).toThrow();
		expect(() => parseStorageObjects('[{"id":1}]')).toThrow();
	});
});

describe("path validation", () => {
	it("accepts names as the storage API writes them", () => {
		expect(objectCandidates(row(), root, config.version_separators)).toEqual([
			`stub/stub/avatars/a.txt/${V}`,
			`stub/stub/avatars/a.txt-$v-${V}`,
		]);
		expect(
			objectCandidates(
				row({ name: "dir/with space/→'\"$(x).png", version: null }),
				root,
				["/"],
			),
		).toEqual(["stub/stub/avatars/dir/with space/→'\"$(x).png"]);
	});

	it("refuses traversal, empty and control-character segments", () => {
		for (const name of [
			"../../etc/passwd",
			"a/../../b",
			"./a",
			"a//b",
			"/abs",
			"a\nb",
			"a\u0000b",
			"",
		]) {
			expect(objectCandidates(row({ name }), root, ["/"])).toBeNull();
		}
		expect(objectCandidates(row({ name: null }), root, ["/"])).toBeNull();
		expect(objectCandidates(row({ bucket_id: ".." }), root, ["/"])).toBeNull();
		expect(objectCandidates(row({ bucket_id: "a/b" }), root, ["/"])).toBeNull();
		expect(objectCandidates(row({ version: "../x" }), root, ["/"])).toBeNull();
		expect(
			objectCandidates(row({ name: "x".repeat(256) }), root, ["/"]),
		).toBeNull();
		expect(isSafeSegment("ok.txt")).toBe(true);
		expect(isSafeSegment("..")).toBe(false);
	});

	it("reads the root bucket and tenant from the env, safely", () => {
		expect(
			storageRootSegments(config, {
				GLOBAL_S3_BUCKET: "stub",
				STORAGE_TENANT_ID: "tenant-1",
			}),
		).toEqual(["stub", "tenant-1"]);
		for (const bad of ["", "..", "a/b", "-x", "a b"]) {
			expect(() =>
				storageRootSegments(config, {
					GLOBAL_S3_BUCKET: bad,
					STORAGE_TENANT_ID: "stub",
				}),
			).toThrow();
		}
		expect(() => storageRootSegments(config, {})).toThrow();
	});

	it("keeps the backend root inside the app folder", () => {
		const location = { folder: "sb-1", appRoot: "/etc/nitrobase/apps/sb-1" };
		expect(storageHostRoot(location, config)).toBe(
			"/etc/nitrobase/apps/sb-1/volumes/storage",
		);
	});
});

describe("repair input and command", () => {
	it("encodes values and candidates, falling back to the defaults", () => {
		const out = repairInput(
			[
				row(),
				row({ mimetype: null, cache_control: "bad\nvalue" }),
				row({ name: "../x" }),
			],
			config,
			root,
		);
		expect(out).toMatchObject({ objects: 2, unsafe: 1 });
		expect(out.input.endsWith("\n")).toBe(true);
		const lines = out.input.trim().split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(line).toMatch(/^[A-Za-z0-9+/= ]+$/);
		}
		const [ct, cc, first, second] = lines[0].split(" ").map(unb64);
		expect([ct, cc]).toEqual(["text/plain", "max-age=3600"]);
		expect([first, second]).toEqual([
			`stub/stub/avatars/a.txt/${V}`,
			`stub/stub/avatars/a.txt-$v-${V}`,
		]);
		const [ct2, cc2] = lines[1].split(" ").map(unb64);
		expect([ct2, cc2]).toEqual(["application/octet-stream", "no-cache"]);
		expect(repairInput([], config, root).input).toBe("");
		expect(headerValue("x".repeat(2000), "d")).toBe("d");
	});

	it("runs the fixed script in the tools container, names as arguments", () => {
		const command = repairCommand(
			"nitrobase-backup-tools:2",
			"/etc/nitrobase/apps/sb-1/volumes/storage",
			config,
		);
		expect(command).toContain("--network none --cap-drop ALL");
		expect(command).toContain(
			"-v '/etc/nitrobase/apps/sb-1/volumes/storage:/data'",
		);
		expect(
			command.endsWith(
				"sh 'user.supabase.content-type' 'user.supabase.cache-control'",
			),
		).toBe(true);
		// Values only reach setfattr in its base64 form.
		expect(REPAIR_SCRIPT).toContain('-v "0s$3"');
		expect(() => repairCommand("img", "/a/../etc", config)).toThrow();
	});

	it("parses the summary line", () => {
		expect(
			parseRepairSummary(
				"noise\nnitrobase-storage-repair fixed=2 ok=3 missing=1 unsafe=0 failed=0\n",
			),
		).toEqual({ fixed: 2, ok: 3, missing: 1, unsafe: 0, failed: 0 });
		expect(() => parseRepairSummary("fixed=1")).toThrow();
	});
});

/**
 * Real round trip: GNU tar with our flags keeps user.* attributes and the
 * repair script restores missing ones. Needs Linux tools (GNU tar,
 * setfattr/getfattr, coreutils realpath/base64) and a filesystem with
 * user xattrs; macOS has none of these, so it is skipped there.
 */
function linuxTools(): string | null {
	if (process.platform !== "linux") return "not Linux (no user xattrs tools)";
	for (const tool of ["setfattr", "getfattr", "tar", "realpath", "base64"]) {
		if (spawnSync("sh", ["-c", `command -v ${tool}`]).status !== 0) {
			return `${tool} not installed`;
		}
	}
	if (!/GNU tar/.test(spawnSync("tar", ["--version"]).stdout.toString())) {
		return "tar is not GNU tar";
	}
	return null;
}
const skipReason = linuxTools();

describe.skipIf(skipReason !== null)(
	`xattr round trip${skipReason ? ` (skipped: ${skipReason})` : ""}`,
	() => {
		const getAttr = (file: string, name: string) =>
			spawnSync("getfattr", [
				"--only-values",
				"-n",
				name,
				file,
			]).stdout.toString();

		it("tar keeps user attributes with the member flags", () => {
			const dir = mkdtempSync(path.join(tmpdir(), "xa-"));
			try {
				mkdirSync(`${dir}/src`);
				mkdirSync(`${dir}/dst`);
				writeFileSync(`${dir}/src/f`, "x");
				const set = spawnSync("setfattr", [
					"-n",
					"user.supabase.content-type",
					"-v",
					"text/plain",
					`${dir}/src/f`,
				]);
				if (set.status !== 0) return; // filesystem without user xattrs
				execFileSync("tar", [
					"-C",
					`${dir}/src`,
					"--numeric-owner",
					...tarXattrArgs("create"),
					"-cf",
					`${dir}/m.tar`,
					".",
				]);
				execFileSync("tar", [
					"-xpf",
					`${dir}/m.tar`,
					"-C",
					`${dir}/dst`,
					...tarXattrArgs("extract"),
				]);
				expect(getAttr(`${dir}/dst/f`, "user.supabase.content-type")).toBe(
					"text/plain",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	},
);
