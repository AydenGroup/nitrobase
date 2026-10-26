import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { apps } from "./schema/apps.ts";
import { backupDestinations, backups } from "./schema/backups.ts";
import { cloudConnections } from "./schema/cloud-sync.ts";
import { databaseLinks } from "./schema/databases.ts";
import { appGitSources, gitCredentials } from "./schema/git.ts";
import { notificationChannels } from "./schema/platform.ts";
import { servers } from "./schema/server.ts";
import { settings } from "./schema/settings.ts";
import { sshKeys } from "./schema/ssh-keys.ts";
import { users } from "./schema/user.ts";

/**
 * Every place a value encrypted with ENCRYPTION_KEY (`#/utils/crypto.ts`) is
 * stored in the database. Key rotation and format upgrades
 * (`scripts/rotate-encryption-key.ts`) walk this list, and a test fails
 * when a `*_encrypted` column is missing from it.
 */
export interface EncryptedColumns {
	table: PgTable;
	/** Primary key column used to address rows. */
	id: AnyPgColumn;
	/** Text columns holding one encrypted value (nullable allowed). */
	columns: AnyPgColumn[];
	/** jsonb column whose `{ encrypted: string }` shape holds one. */
	jsonField?: { column: AnyPgColumn; key: string };
}

export const encryptedColumns: EncryptedColumns[] = [
	{
		table: sshKeys,
		id: sshKeys.id,
		columns: [sshKeys.privateKeyEncrypted, sshKeys.passphraseEncrypted],
	},
	{
		table: servers,
		id: servers.id,
		columns: [servers.passwordEncrypted, servers.tunnelTokenEncrypted],
	},
	{
		table: apps,
		id: apps.id,
		columns: [
			apps.envEncrypted,
			apps.envDeployedEncrypted,
			apps.serviceEnvEncrypted,
			apps.customSpecEncrypted,
		],
	},
	{
		table: databaseLinks,
		id: databaseLinks.id,
		columns: [databaseLinks.passwordEncrypted],
	},
	{
		table: gitCredentials,
		id: gitCredentials.id,
		columns: [gitCredentials.secretEncrypted],
	},
	{
		table: appGitSources,
		id: appGitSources.appId,
		columns: [
			appGitSources.buildSecretsEncrypted,
			appGitSources.webhookSecretEncrypted,
		],
	},
	{
		table: users,
		id: users.id,
		columns: [users.totpSecretEncrypted, users.totpPendingSecretEncrypted],
	},
	{
		table: backupDestinations,
		id: backupDestinations.id,
		columns: [backupDestinations.configEncrypted],
	},
	{
		table: cloudConnections,
		id: cloudConnections.id,
		columns: [cloudConnections.configEncrypted],
	},
	{
		table: backups,
		id: backups.id,
		columns: [backups.customSpecEncrypted],
	},
	{
		table: notificationChannels,
		id: notificationChannels.id,
		columns: [notificationChannels.configEncrypted],
	},
	{
		table: settings,
		id: settings.key,
		columns: [],
		jsonField: { column: settings.value, key: "encrypted" },
	},
];
