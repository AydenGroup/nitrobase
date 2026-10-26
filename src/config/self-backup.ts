import { APP_ID } from "#/config/shared.ts";

/**
 * Names inside a panel self-backup (client-safe): the encrypted, gzipped
 * tar `<id>-backup/{manifest.json, <id>.sql}`, stored at
 * `<id>/<stamp>-<backup id>.tar.gz.enc` on the destination.
 */
export interface SelfBackupLayout {
	/** Folder at the root of the tar. */
	root: string;
	/** Database dump inside `root` (also its manifest member path). */
	dump: string;
}

export const SELF_BACKUP_MANIFEST = "manifest.json";

const layoutOf = (id: string): SelfBackupLayout => ({
	root: `${id}-backup`,
	dump: `${id}.sql`,
});

/** Layout of self-backups. */
export const SELF_BACKUP_LAYOUT = layoutOf(APP_ID);

/** Destination folder of new self-backups. */
const SELF_BACKUP_FOLDER = APP_ID;

/** Destination key of a new self-backup. */
export const selfBackupKey = (stamp: string, id: string) =>
	`${SELF_BACKUP_FOLDER}/${stamp}-${id}.tar.gz.enc`;

/** Example file name shown to the owner (first-run restore). */
export const SELF_BACKUP_EXAMPLE = selfBackupKey("<date>", "<id>");
