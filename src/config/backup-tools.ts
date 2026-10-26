/**
 * The per-server backup tools image and the tar flags of member archives
 * (bind folders and named volumes, see `server/services/backup/archive.ts`).
 * Server-only data, no secrets.
 *
 * Changing `packages` changes the image: bump the default
 * `BACKUP_TOOLS_IMAGE` tag (config/server.ts) so servers build it again.
 */

/** Alpine packages of the tools image (`tar` is GNU tar). */
export const BACKUP_TOOLS_PACKAGES = [
	"tar",
	"zstd",
	"coreutils",
	"findutils",
	// getfattr/setfattr: storage metadata checks and repairs (plugins).
	"attr",
] as const;

/**
 * Extended attributes kept by member tars, on create and on extract.
 * Only the `user.*` namespace: apps store data there (e.g. Supabase
 * Storage's file backend keeps an object's content type and cache control
 * in `user.supabase.*`), it needs no capability and grants nothing.
 * Excluded explicitly (defence in depth, the include list already skips
 * them): `security.*` (file capabilities would give a restored binary
 * privileges, and SELinux labels belong to the target host's relabelling,
 * e.g. compose `:z`), `trusted.*` (needs CAP_SYS_ADMIN, dropped in the
 * tools container) and `system.*` (POSIX ACLs, not part of the archive).
 */
const TAR_XATTRS = {
	include: ["user.*"],
	exclude: ["security.*", "trusted.*", "system.*"],
	/**
	 * Extract only: a destination filesystem without user xattrs must not
	 * fail the restore (the data matters more; plugins report files still
	 * missing their attributes, e.g. the Supabase storage check).
	 */
	extractWarnings: ["no-xattr-write"],
} as const;

/** GNU tar arguments for `TAR_XATTRS` (unquoted: callers quote them). */
export function tarXattrArgs(mode: "create" | "extract"): string[] {
	return [
		"--xattrs",
		...TAR_XATTRS.include.map((pattern) => `--xattrs-include=${pattern}`),
		...TAR_XATTRS.exclude.map((pattern) => `--xattrs-exclude=${pattern}`),
		...(mode === "extract"
			? TAR_XATTRS.extractWarnings.map((warning) => `--warning=${warning}`)
			: []),
	];
}
