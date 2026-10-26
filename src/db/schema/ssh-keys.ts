import {
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { SSH_KEY_TYPES } from "#/config/ssh-key-types.ts";
import { teams } from "./teams";
import { users } from "./user";

export const sshKeyTypeEnum = pgEnum("ssh_key_type", SSH_KEY_TYPES);

/**
 * Team SSH key library. Servers reference a key by id, so rotating a
 * key here applies to every server that uses it.
 */
export const sshKeys = pgTable(
	"ssh_keys",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		/** Owning team (access is checked against the caller's team). */
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		/** Member who added it (kept when the member leaves). */
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),

		// Metadata
		name: text("name").notNull(),
		description: text("description"),
		keyType: sshKeyTypeEnum("key_type").notNull(),

		// Encrypted at rest (AES-256-GCM)
		privateKeyEncrypted: text("private_key_encrypted").notNull(),
		// Optional passphrase for encrypted private keys (encrypted at rest)
		passphraseEncrypted: text("passphrase_encrypted"),
		publicKey: text("public_key").notNull(),

		// Fingerprint "SHA256:<base64>" of the public key blob (as `ssh-keygen -lf`)
		fingerprint: text("fingerprint").notNull(),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [index("ssh_keys_team_id_idx").on(table.teamId)],
);
