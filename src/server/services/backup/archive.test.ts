import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	archiveSourceCommand,
	assertSafeListing,
	buildManifest,
	ensureToolsImageCommand,
	extractArchiveCommand,
	hookCommand,
	isRemovableWorkDir,
	listArchiveCommand,
	listWorkDirsCommand,
	packCommand,
	parseChecksums,
	parseFileDigest,
	parseSizes,
	parseTarListing,
	parseWorkDirListing,
	removeWorkDirsCommand,
	restoreSourceCommand,
	sizesCommand,
	sweepWorkDirsCommand,
	verifyManifest,
} from "./archive";

const sha = (char: string) => char.repeat(64);
const base = {
	createdAt: new Date("2026-10-04T12:00:00Z"),
	app: {
		id: "a1",
		name: "Demo",
		templateId: "pocketbase",
		folder: "pocketbase-12345678",
	},
	template: { version: "v0.30.0", commitSha: "c".repeat(40) },
	database: null,
};

describe("manifest", () => {
	const checksums = new Map([
		["env.enc", sha("a")],
		["compose/docker-compose.yml", sha("b")],
		["files/0.tar", sha("d")],
	]);
	const manifest = buildManifest({
		...base,
		sources: { "files/0.tar": "pb_data" },
		checksums,
		sizes: new Map([["files/0.tar", 1024]]),
	});

	it("lists every member with kind, source, checksum and size", () => {
		expect(manifest.members).toEqual([
			{
				path: "compose/docker-compose.yml",
				kind: "compose",
				sha256: sha("b"),
				size: 0,
			},
			{ path: "env.enc", kind: "env", sha256: sha("a"), size: 0 },
			{
				path: "files/0.tar",
				kind: "path",
				source: "pb_data",
				sha256: sha("d"),
				size: 1024,
			},
		]);
		expect(manifest.format).toBe(1);
	});

	it("verifies against the extracted members", () => {
		const extracted = new Map([...checksums, ["manifest.json", sha("f")]]);
		expect(
			verifyManifest(JSON.parse(JSON.stringify(manifest)), extracted),
		).toEqual(manifest);
		expect(() =>
			verifyManifest(
				manifest,
				new Map([...extracted, ["files/0.tar", sha("e")]]),
			),
		).toThrow(/Checksum mismatch/);
		const missing = new Map(extracted);
		missing.delete("env.enc");
		expect(() => verifyManifest(manifest, missing)).toThrow(/missing/);
		expect(() =>
			verifyManifest(
				manifest,
				new Map([...extracted, ["db/extra.sql", sha("1")]]),
			),
		).toThrow(/not listed/);
		expect(() =>
			verifyManifest({ ...manifest, format: 2 }, extracted),
		).toThrow();
	});

	it("refuses unknown members and archives without env", () => {
		expect(() =>
			buildManifest({
				...base,
				sources: {},
				checksums: new Map([["../x", sha("a")]]),
				sizes: new Map(),
			}),
		).toThrow();
		expect(() =>
			buildManifest({
				...base,
				sources: {},
				checksums: new Map([["files/0.tar", sha("a")]]),
				sizes: new Map(),
			}),
		).toThrow(/env/);
	});

	it("parses sha256sum and digest output", () => {
		expect(
			parseChecksums(`${sha("a")}  ./env.enc\n${sha("b")}  ./files/0.tar\n`),
		).toEqual(
			new Map([
				["env.enc", sha("a")],
				["files/0.tar", sha("b")],
			]),
		);
		expect(parseFileDigest(`123\n${sha("c")}\n`)).toEqual({
			size: 123,
			sha256: sha("c"),
		});
		expect(() => parseFileDigest("x")).toThrow();
	});
});

describe("extraction guard", () => {
	const line = (type: string, name: string) =>
		`${type}rw-r--r-- 0/0      12 2026-10-04 12:00 ${name}`;
	const ok = [
		line("d", "./"),
		line("-", "./manifest.json"),
		line("-", "./env.enc"),
		line("d", "./files/"),
		line("-", "./files/0.tar"),
		line("d", "./db/"),
		line("-", "./db/dumpall.sql"),
	].join("\n");

	it("accepts a well-formed archive", () => {
		expect(assertSafeListing(parseTarListing(ok))).toEqual([
			"manifest.json",
			"env.enc",
			"files/0.tar",
			"db/dumpall.sql",
		]);
	});

	it.each([
		["absolute path", line("-", "/etc/passwd")],
		["traversal", line("-", "./files/../../x")],
		["symlink", "lrwxrwxrwx 0/0 0 2026-10-04 12:00 ./env.enc -> /etc/shadow"],
		["hard link", "hrw-r--r-- 0/0 0 2026-10-04 12:00 ./env.enc link to ./x"],
		["device", line("c", "./files/0.tar")],
		["fifo", line("p", "./db/x")],
		["unknown member", line("-", "./bin/sh")],
		["unknown folder", line("d", "./tmp/")],
		["duplicate", `${line("-", "./env.enc")}\n${line("-", "./env.enc")}`],
		["backslash", line("-", "./db\\x")],
	])("rejects %s", (_name, extra) => {
		expect(() =>
			assertSafeListing(parseTarListing(`${ok}\n${extra}`)),
		).toThrow();
	});

	it("requires a manifest and readable lines", () => {
		expect(() =>
			assertSafeListing(parseTarListing(line("-", "./env.enc"))),
		).toThrow(/manifest/);
		expect(() => parseTarListing("garbage")).toThrow();
	});
});

describe("commands", () => {
	const tools = "nitrobase-backup-tools:1";
	const work = "/etc/nitrobase/backup-work/backup-0a1b2c";
	const caps =
		"docker run --rm -i --init --network none --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add FSETID";

	it("builds the tools image once", () => {
		expect(
			ensureToolsImageCommand({ image: tools, baseImage: "alpine:3.22" }),
		).toBe(
			"docker image inspect 'nitrobase-backup-tools:1' >/dev/null 2>&1 || printf '%s\\n' 'FROM alpine:3.22' 'RUN apk add --no-cache tar zstd coreutils findutils attr' | docker build -q -t 'nitrobase-backup-tools:1' -",
		);
	});

	it("archives sources read-only through the tools container", () => {
		expect(
			archiveSourceCommand(
				tools,
				"/etc/nitrobase/apps/pb-1/pb_data",
				`${work}/members/files/0.tar`,
			),
		).toBe(
			`${caps} -v '/etc/nitrobase/apps/pb-1/pb_data:/src:ro' 'nitrobase-backup-tools:1' sh -c 'tar -C /src --numeric-owner '\\''--xattrs'\\'' '\\''--xattrs-include=user.*'\\'' '\\''--xattrs-exclude=security.*'\\'' '\\''--xattrs-exclude=trusted.*'\\'' '\\''--xattrs-exclude=system.*'\\'' -cf - .' sh > '${work}/members/files/0.tar'`,
		);
		expect(
			archiveSourceCommand(tools, "supabase-1_db-config", "/tmp/x"),
		).toContain("-v 'supabase-1_db-config:/src:ro'");
	});

	it("restores into the target through the container", () => {
		expect(
			restoreSourceCommand(
				tools,
				"/etc/nitrobase/apps/pb-1/pb_data",
				work,
				"files/0.tar",
			),
		).toBe(
			`${caps} -v '/etc/nitrobase/apps/pb-1/pb_data:/dst' -v '${work}:/work:ro' 'nitrobase-backup-tools:1' sh -c 'find /dst -mindepth 1 -delete && tar -xpf "/work/x/$1" -C /dst --numeric-owner '\\''--xattrs'\\'' '\\''--xattrs-include=user.*'\\'' '\\''--xattrs-exclude=security.*'\\'' '\\''--xattrs-exclude=trusted.*'\\'' '\\''--xattrs-exclude=system.*'\\'' '\\''--warning=no-xattr-write'\\''' sh 'files/0.tar'`,
		);
		expect(() => restoreSourceCommand(tools, "/x", work, "../etc")).toThrow();
		expect(() =>
			restoreSourceCommand(tools, "/x/../etc", work, "files/0.tar"),
		).toThrow();
		expect(() =>
			restoreSourceCommand(tools, "vol;rm", work, "files/0.tar"),
		).toThrow();
	});

	it("packs, lists and extracts in the staging folder", () => {
		expect(packCommand(tools, work, 6)).toContain(
			"'tar -C /work/members --numeric-owner -cf - . | zstd -q -T0 -6 -o /work/archive.tar.zst'",
		);
		expect(listArchiveCommand(tools, work)).toContain(`-v '${work}:/work:ro'`);
		expect(extractArchiveCommand(tools, work)).toContain(
			"--no-same-owner --no-same-permissions",
		);
	});

	it("sweeps old direct children and dead job folders, printing them", () => {
		const root = "/etc/nitrobase/backup-work";
		expect(
			sweepWorkDirsCommand(root, 361.2, [
				`${root}/backup-a1b2c3d4e5f6`,
				"/etc/nitrobase/apps/x",
				`${root}/../x`,
			]),
		).toBe(
			[
				"[ -d '/etc/nitrobase/backup-work' ] || exit 0",
				"find '/etc/nitrobase/backup-work' -mindepth 1 -maxdepth 1 -type d -mmin +362 -print -exec rm -rf -- {} +",
				"[ -d '/etc/nitrobase/backup-work/backup-a1b2c3d4e5f6' ] && echo '/etc/nitrobase/backup-work/backup-a1b2c3d4e5f6' && rm -rf -- '/etc/nitrobase/backup-work/backup-a1b2c3d4e5f6'",
				"true",
			].join("\n"),
		);
	});

	it("lists and removes chosen staging folders only under the root", () => {
		const root = "/etc/nitrobase/backup-work";
		expect(listWorkDirsCommand(root)).toContain('[ ! -L "$d" ]');
		expect(
			parseWorkDirListing(
				[
					`${root}/backup-e750df9d3d9f\t1791000000\t821248`,
					`${root}/download-01f219c9937a\t1791000100\t12`,
					`${root}/odd name\t1\t1`,
					"/etc/passwd\t1\t1",
					"garbage",
				].join("\n"),
				root,
			),
		).toEqual([
			{
				path: `${root}/backup-e750df9d3d9f`,
				modifiedAt: new Date(1791000000 * 1000),
				sizeKb: 821248,
			},
			{
				path: `${root}/download-01f219c9937a`,
				modifiedAt: new Date(1791000100 * 1000),
				sizeKb: 12,
			},
		]);
		const command = removeWorkDirsCommand(root, [
			`${root}/backup-e750df9d3d9f`,
			`${root}/../apps`,
			"/",
		]);
		expect(command).toContain(
			"rm -rf -- '/etc/nitrobase/backup-work/backup-e750df9d3d9f'",
		);
		expect(command).not.toContain("apps");
		expect(command.split("\n")).toHaveLength(2);
	});

	it("quotes hook commands", () => {
		expect(hookCommand("app-1-db", ["sh", "-c", "echo 'x'; id"])).toBe(
			`docker exec 'app-1-db' 'sh' '-c' 'echo '\\''x'\\''; id'`,
		);
		expect(() => hookCommand("x;id", ["true"])).toThrow();
	});
});

describe("isRemovableWorkDir", () => {
	const root = "/etc/nitrobase/backup-work";
	it("accepts only generated staging folders directly under the root", () => {
		expect(isRemovableWorkDir(`${root}/backup-a1b2c3d4e5f6`, root)).toBe(true);
		expect(isRemovableWorkDir(`${root}/../apps`, root)).toBe(false);
		expect(isRemovableWorkDir(`${root}/backup-x/../../x`, root)).toBe(false);
		expect(
			isRemovableWorkDir("/etc/nitrobase/apps/backup-a1b2c3d4", root),
		).toBe(false);
		expect(isRemovableWorkDir(root, root)).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("sizesCommand (real sh)", () => {
	it("prints the size and relative path of every file, POSIX tools only", () => {
		expect(sizesCommand("/x")).not.toContain("-printf");
		const root = mkdtempSync(path.join(os.tmpdir(), "sizes-"));
		try {
			mkdirSync(path.join(root, "db", "nested dir"), { recursive: true });
			writeFileSync(path.join(root, "env.enc"), "12345");
			writeFileSync(path.join(root, "db", "dump.sql"), "");
			writeFileSync(path.join(root, "db", "nested dir", "a b.txt"), "abc");
			writeFileSync(path.join(root, ".hidden"), "xy");
			const sizes = parseSizes(
				execFileSync("sh", ["-c", sizesCommand(root)]).toString(),
			);
			expect(Object.fromEntries(sizes)).toEqual({
				"env.enc": 5,
				"db/dump.sql": 0,
				"db/nested dir/a b.txt": 3,
				".hidden": 2,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prints nothing for an empty folder", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "sizes-"));
		try {
			expect(execFileSync("sh", ["-c", sizesCommand(root)]).toString()).toBe(
				"",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
