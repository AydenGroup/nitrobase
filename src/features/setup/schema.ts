/** Result of the first-run "Restore Nitrobase from a self-backup". */
export interface FirstRunRestoreResult {
	/** Accounts in the restored database (sign in with one of them). */
	accounts: number;
	/** Secrets re-encrypted for this installation's ENCRYPTION_KEY. */
	reencrypted: number;
	/**
	 * The backup was made with another ENCRYPTION_KEY: app backups of the
	 * old installation need it in ENCRYPTION_KEY_PREVIOUS.
	 */
	keyChanged: boolean;
	backupCreatedAt: string;
}
