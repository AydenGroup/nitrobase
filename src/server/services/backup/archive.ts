import path from "node:path";
import { z } from "zod";
import { BACKUP_TOOLS_PACKAGES, tarXattrArgs } from "#/config/backup-tools.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { internalError } from "#/utils/error.ts";

/**
 * Full-backup archive (`.tar.zst`), built on the managed server:
 *
 *   manifest.json                 app, template version/SHA, member checksums
 *   env.enc                       app env, encrypted with the instance key
 *   compose/docker-compose.yml    the deployed (transformed) compose file
 *   db/<file>                     provider plugin dump (e.g. pg_dumpall)
 *   files/<n>.tar                 bind folders inside the app folder
 *   volumes/<n>.tar               compose named volumes
 *
 * Member tars are produced and restored inside a throwaway tools container
 * (no network, minimal capabilities), never through host paths of volumes.
 */

const ARCHIVE_FORMAT = 1;
export const MANIFEST_FILE = "manifest.json";
export const ENV_FILE = "env.enc";
export const COMPOSE_FILE = "compose/docker-compose.yml";

const SHA256 = /^[a-f0-9]{64}$/;

const ManifestMemberSchema = z.object({
	path: z.string(),
	kind: z.enum(["env", "compose", "db", "path", "volume"]),
	/** App-folder path or compose volume name the member was taken from. */
	source: z.string().optional(),
	sha256: z.string().regex(SHA256),
	size: z.number().int().min(0),
});
type ManifestMember = z.infer<typeof ManifestMemberSchema>;

const BackupManifestSchema = z.object({
	format: z.literal(ARCHIVE_FORMAT),
	createdAt: z.string(),
	app: z.object({
		id: z.string(),
		name: z.string(),
		templateId: z.string(),
		folder: z.string(),
	}),
	template: z.object({ version: z.string(), commitSha: z.string() }),
	/** Provider plugin database strategy used (null: files only). */
	database: z.object({ strategy: z.string(), service: z.string() }).nullable(),
	members: z.array(ManifestMemberSchema),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

/** Allowed member paths (relative, as stored without the `./` prefix). */
const MEMBER_PATTERNS = [
	/^env\.enc$/,
	/^compose\/docker-compose\.yml$/,
	/^db\/[a-z0-9][a-z0-9._-]{0,63}$/,
	/^files\/\d{1,4}\.tar$/,
	/^volumes\/\d{1,4}\.tar$/,
];
const DIRS = new Set(["", "compose", "db", "files", "volumes"]);

function isMemberPath(member: string): boolean {
	return MEMBER_PATTERNS.some((pattern) => pattern.test(member));
}

function memberKindOf(member: string): ManifestMember["kind"] {
	if (member === ENV_FILE) return "env";
	if (member === COMPOSE_FILE) return "compose";
	if (member.startsWith("db/")) return "db";
	if (member.startsWith("files/")) return "path";
	return "volume";
}

/** Parse `sha256sum` output (`<hash>  ./<path>` per line). */
export function parseChecksums(output: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of output.split("\n")) {
		const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line.trim());
		if (match) out.set(match[2].replace(/^\.\//, ""), match[1]);
	}
	return out;
}

/** Parse `<size> <path>` lines (`sizesCommand`). */
export function parseSizes(output: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of output.split("\n")) {
		const match = /^(\d+) (.+)$/.exec(line.trim());
		if (match) out.set(match[2], Number(match[1]));
	}
	return out;
}

export function buildManifest(input: {
	createdAt: Date;
	app: BackupManifest["app"];
	template: BackupManifest["template"];
	database: BackupManifest["database"];
	sources: Record<string, string>;
	checksums: Map<string, string>;
	sizes: Map<string, number>;
}): BackupManifest {
	const members: ManifestMember[] = [];
	for (const [member, sha256] of [...input.checksums.entries()].sort()) {
		if (!isMemberPath(member)) {
			throw new TemplateError("ARCHIVE_MEMBER_UNEXPECTED", { member });
		}
		members.push({
			path: member,
			kind: memberKindOf(member),
			...(input.sources[member] ? { source: input.sources[member] } : {}),
			sha256,
			size: input.sizes.get(member) ?? 0,
		});
	}
	if (!members.some((member) => member.kind === "env")) {
		throw new TemplateError("ARCHIVE_NO_ENV");
	}
	return BackupManifestSchema.parse({
		format: ARCHIVE_FORMAT,
		createdAt: input.createdAt.toISOString(),
		app: input.app,
		template: input.template,
		database: input.database,
		members,
	});
}

/**
 * Check an extracted archive against its manifest: same member set, same
 * sha256 for each (computed on the server after extraction).
 */
export function verifyManifest(
	raw: unknown,
	checksums: Map<string, string>,
): BackupManifest {
	const parsed = BackupManifestSchema.safeParse(raw);
	if (!parsed.success) throw new TemplateError("ARCHIVE_MANIFEST_INVALID");
	const manifest = parsed.data;
	const listed = new Set(manifest.members.map((member) => member.path));
	for (const member of manifest.members) {
		if (!isMemberPath(member.path)) {
			throw new TemplateError("ARCHIVE_MEMBER_INVALID", {
				member: member.path,
			});
		}
		const actual = checksums.get(member.path);
		if (!actual) {
			throw new TemplateError("ARCHIVE_MEMBER_MISSING", {
				member: member.path,
			});
		}
		if (actual !== member.sha256) {
			throw new TemplateError("ARCHIVE_MEMBER_CHECKSUM", {
				member: member.path,
			});
		}
	}
	for (const file of checksums.keys()) {
		if (file !== MANIFEST_FILE && !listed.has(file)) {
			throw new TemplateError("ARCHIVE_MEMBER_UNLISTED", { member: file });
		}
	}
	return manifest;
}

export interface ArchiveEntry {
	type: string;
	path: string;
}

/**
 * Parse `tar -tv --numeric-owner` output (GNU tar):
 * `-rw-r--r-- 0/0  123 2026-10-04 15:00 ./manifest.json`.
 */
export function parseTarListing(output: string): ArchiveEntry[] {
	return output
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line) => {
			const match =
				/^(\S)\S{9}\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s+(.+)$/.exec(
					line,
				);
			if (!match) {
				throw new TemplateError("ARCHIVE_ENTRY_UNREADABLE", { entry: line });
			}
			return { type: match[1], path: match[2] };
		});
}

/**
 * Extraction guard for the outer archive: only regular files and
 * directories, only known member paths, nothing absolute, no `..`, no
 * links, devices or duplicates.
 */
export function assertSafeListing(entries: ArchiveEntry[]): string[] {
	const seen = new Set<string>();
	const files: string[] = [];
	for (const entry of entries) {
		const name = entry.path;
		if (
			name.startsWith("/") ||
			name.includes("\\") ||
			name.includes(" -> ") ||
			name.includes(" link to ")
		) {
			throw new TemplateError("ARCHIVE_ENTRY_UNSAFE", { entry: name });
		}
		const relative = name.replace(/^\.\//, "").replace(/\/$/, "");
		if (
			relative.split("/").includes("..") ||
			(relative !== "" && path.posix.normalize(relative) !== relative)
		) {
			throw new TemplateError("ARCHIVE_ENTRY_UNSAFE", { entry: name });
		}
		if (seen.has(relative)) {
			throw new TemplateError("ARCHIVE_ENTRY_DUPLICATE", { entry: name });
		}
		seen.add(relative);
		if (entry.type === "d") {
			if (!DIRS.has(relative)) {
				throw new TemplateError("ARCHIVE_FOLDER_UNEXPECTED", { entry: name });
			}
			continue;
		}
		if (entry.type !== "-") {
			throw new TemplateError("ARCHIVE_ENTRY_NOT_FILE", { entry: name });
		}
		if (relative !== MANIFEST_FILE && !isMemberPath(relative)) {
			throw new TemplateError("ARCHIVE_ENTRY_UNEXPECTED", { entry: name });
		}
		files.push(relative);
	}
	if (!files.includes(MANIFEST_FILE)) {
		throw new TemplateError("ARCHIVE_NO_MANIFEST");
	}
	return files;
}

// ---------------------------------------------------------------------------
// Commands

export interface ToolsImage {
	image: string;
	baseImage: string;
}

/** Build the per-server tools image (GNU tar + zstd + attr) once. */
export function ensureToolsImageCommand(tools: ToolsImage): string {
	const dockerfile = [
		`FROM ${tools.baseImage}`,
		`RUN apk add --no-cache ${BACKUP_TOOLS_PACKAGES.join(" ")}`,
	];
	return `docker image inspect ${q(tools.image)} >/dev/null 2>&1 || printf '%s\\n' ${dockerfile.map(q).join(" ")} | docker build -q -t ${q(tools.image)} -`;
}

export type Mount = { source: string; target: string; readOnly?: boolean };

const CONTAINER_TARGET = /^\/[a-z]+$/;
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

function mountArg(mount: Mount): string {
	if (!CONTAINER_TARGET.test(mount.target)) {
		throw internalError(`Invalid mount target ${mount.target}`);
	}
	if (
		!(
			mount.source.startsWith("/") &&
			path.posix.normalize(mount.source) === mount.source
		) &&
		!VOLUME_NAME.test(mount.source)
	) {
		throw internalError(`Invalid mount source ${mount.source}`);
	}
	return `-v ${q(`${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`)}`;
}

/**
 * Throwaway tools container: no network, only the capabilities tar needs
 * to restore ownership/modes (no MKNOD: archives can't create devices).
 */
export function toolsCommand(
	image: string,
	mounts: Mount[],
	script: string,
	args: string[] = [],
): string {
	return [
		"docker run --rm -i --init --network none --cap-drop ALL",
		"--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add FSETID",
		...mounts.map(mountArg),
		q(image),
		"sh -c",
		q(script),
		"sh",
		...args.map(q),
	].join(" ");
}

/** Member tar flags: numeric ids and the kept extended attributes. */
function memberTarFlags(mode: "create" | "extract"): string {
	return ["--numeric-owner", ...tarXattrArgs(mode).map(q)].join(" ");
}

/**
 * Tar of a bind folder or named volume, written to `outFile` on the host,
 * with the `user.*` extended attributes (`TAR_XATTRS`).
 */
export function archiveSourceCommand(
	image: string,
	source: string,
	outFile: string,
): string {
	return `${toolsCommand(image, [{ source, target: "/src", readOnly: true }], `tar -C /src ${memberTarFlags("create")} -cf - .`)} > ${q(outFile)}`;
}

/**
 * Replace the content of a bind folder or named volume with a member tar,
 * extended attributes included (archives made before they were kept have
 * none: plugins may repair theirs, see `ServerPlugin.afterRestoreData`).
 * GNU tar strips leading `/` and refuses `..` members; devices can't be
 * created (no MKNOD).
 */
export function restoreSourceCommand(
	image: string,
	target: string,
	workDir: string,
	member: string,
): string {
	if (!isMemberPath(member))
		throw new TemplateError("ARCHIVE_MEMBER_INVALID", { member });
	return toolsCommand(
		image,
		[
			{ source: target, target: "/dst" },
			{ source: workDir, target: "/work", readOnly: true },
		],
		`find /dst -mindepth 1 -delete && tar -xpf "/work/x/$1" -C /dst ${memberTarFlags("extract")}`,
		[member],
	);
}

/** Empty a bind folder or named volume (e.g. a database data dir). */
export function resetSourceCommand(image: string, target: string): string {
	return toolsCommand(
		image,
		[{ source: target, target: "/dst" }],
		"find /dst -mindepth 1 -delete",
	);
}

/** Pack `<work>/members` into `<work>/archive.tar.zst`. */
export function packCommand(
	image: string,
	workDir: string,
	level: number,
): string {
	const zstd = Math.min(19, Math.max(1, Math.floor(level)));
	return toolsCommand(
		image,
		[{ source: workDir, target: "/work" }],
		`tar -C /work/members --numeric-owner -cf - . | zstd -q -T0 -${zstd} -o /work/archive.tar.zst`,
	);
}

export function listArchiveCommand(image: string, workDir: string): string {
	return toolsCommand(
		image,
		[{ source: workDir, target: "/work", readOnly: true }],
		"zstd -dc /work/archive.tar.zst | tar -tvf - --numeric-owner",
	);
}

/** Extract into `<work>/x` (only after `assertSafeListing`). */
export function extractArchiveCommand(image: string, workDir: string): string {
	return toolsCommand(
		image,
		[{ source: workDir, target: "/work" }],
		"mkdir -p /work/x && zstd -dc /work/archive.tar.zst | tar -xf - -C /work/x --no-same-owner --no-same-permissions",
	);
}

/** sha256 of every file under `dir`, paths relative. */
export function checksumsCommand(dir: string): string {
	return `cd ${q(dir)} && find . -type f -print0 | sort -z | xargs -0 -r sha256sum`;
}

/**
 * `<size> <path>` per file under `dir`, paths relative (no `./`). POSIX
 * find + sh, no GNU `find -printf`: `stat -c %s` (GNU, busybox) with a
 * `stat -f %z` (BSD) fallback. One line per file, so a file name with a
 * newline would break the format (`parseSizes` would misread it); the
 * staging members are files the panel creates itself, so this is
 * theoretical.
 */
export function sizesCommand(dir: string): string {
	const each = `for f do s="$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")" || exit 1; printf '%s %s\\n' "$s" "\${f#./}"; done`;
	return `cd ${q(dir)} && find . -type f -exec sh -c ${q(each)} sh {} +`;
}

/** `<size> <sha256>` of one file. */
export function fileDigestCommand(file: string): string {
	return `stat -c %s ${q(file)} && sha256sum ${q(file)} | cut -d' ' -f1`;
}

export function parseFileDigest(output: string): {
	size: number;
	sha256: string;
} {
	const [size, sha256] = output.trim().split(/\s+/);
	if (!/^\d+$/.test(size ?? "") || !SHA256.test(sha256 ?? "")) {
		throw new TemplateError("ARCHIVE_STAT_UNREADABLE");
	}
	return { size: Number(size), sha256 };
}

/** Create a private staging folder (and its `members/db|files|volumes`). */
export function prepareWorkDirCommand(workDir: string): string {
	return `umask 077 && mkdir -p ${["members/db", "members/files", "members/volumes", "members/compose"].map((dir) => q(`${workDir}/${dir}`)).join(" ")}`;
}

/**
 * Remove staging folders older than `minutes` (left by a Nitrobase crash
 * mid-job; they may hold an rclone.conf). Only direct children of `root`.
 */
export function sweepWorkDirsCommand(
	root: string,
	minutes: number,
	/** Folders of finished/interrupted jobs: removed whatever their age. */
	deadDirs: string[] = [],
): string {
	const age = Math.max(1, Math.ceil(minutes));
	const dead = deadDirs
		.filter((dir) => isRemovableWorkDir(dir, root))
		.map((dir) => `[ -d ${q(dir)} ] && echo ${q(dir)} && rm -rf -- ${q(dir)}`);
	// Prints every removed folder (one per line) for the log.
	return [
		`[ -d ${q(root)} ] || exit 0`,
		`find ${q(root)} -mindepth 1 -maxdepth 1 -type d -mmin +${age} -print -exec rm -rf -- {} +`,
		...dead,
		"true",
	].join("\n");
}

/**
 * List staging folders (direct children of `root`, no symlinks): one line
 * per folder, `path<TAB>mtime epoch seconds<TAB>size KiB`.
 */
export function listWorkDirsCommand(root: string): string {
	return [
		`[ -d ${q(root)} ] || exit 0`,
		`for d in ${q(root)}/*; do`,
		`  [ -d "$d" ] && [ ! -L "$d" ] || continue`,
		`  printf '%s\t%s\t%s\n' "$d" "$(stat -c %Y -- "$d")" "$(du -sk -- "$d" | cut -f1)"`,
		"done",
		"true",
	].join("\n");
}

export interface WorkDirEntry {
	path: string;
	modifiedAt: Date;
	sizeKb: number;
}

export function parseWorkDirListing(
	output: string,
	root: string,
): WorkDirEntry[] {
	return output
		.split("\n")
		.map((line) => line.split("\t"))
		.filter(
			([path, mtime, size]) =>
				!!path &&
				/^\d+$/.test(mtime ?? "") &&
				/^\d+$/.test(size ?? "") &&
				isRemovableWorkDir(path, root),
		)
		.map(([path, mtime, size]) => ({
			path,
			modifiedAt: new Date(Number(mtime) * 1000),
			sizeKb: Number(size),
		}));
}

/** Remove the given staging folders (validated: one level under `root`). */
export function removeWorkDirsCommand(root: string, dirs: string[]): string {
	return [
		...dirs
			.filter((dir) => isRemovableWorkDir(dir, root))
			.map(
				(dir) => `[ -d ${q(dir)} ] && echo ${q(dir)} && rm -rf -- ${q(dir)}`,
			),
		"true",
	].join("\n");
}

/** Staging folders the recovery may delete: one level under backup-work. */
export function isRemovableWorkDir(path: string, root: string): boolean {
	const prefix = `${root}/`;
	if (!path.startsWith(prefix)) return false;
	return /^[a-z]+-[a-f0-9]{8,32}$/.test(path.slice(prefix.length));
}

export function removeWorkDirCommand(workDir: string): string {
	return `rm -rf -- ${q(workDir)}`;
}

/** `docker exec` of a template hook command (argv, each part quoted). */
export function hookCommand(container: string, command: string[]): string {
	if (!/^[a-z0-9][a-z0-9_.-]*$/.test(container)) {
		throw internalError(`Invalid container ${container}`);
	}
	return `docker exec ${q(container)} ${command.map(q).join(" ")}`;
}
