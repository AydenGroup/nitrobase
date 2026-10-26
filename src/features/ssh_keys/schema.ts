import type { I18n } from "@lingui/core";
import { z } from "zod";
import {
	SSH_KEY_PASSPHRASE_MAX_LENGTH,
	SSH_KEY_TYPES,
} from "#/config/ssh-key-types.ts";
import type { sshKeys } from "#/db/schema/ssh-keys";

const passphraseSchema = (i18n: I18n) =>
	z
		.string()
		.max(SSH_KEY_PASSPHRASE_MAX_LENGTH, {
			message: i18n._("Use at most {max} characters", {
				max: SSH_KEY_PASSPHRASE_MAX_LENGTH,
			}),
		})
		.optional();

/** Import an existing key pair (type and fingerprint derive from the key). */
export const AddSSHKeySchema = (i18n: I18n) =>
	z.object({
		name: z.string().min(1, { message: i18n._("Name is required") }),
		description: z.string().optional(),
		privateKey: z
			.string()
			.min(1, { message: i18n._("Private key is required") }),
		// Empty: derived from the private key.
		publicKey: z.string().optional(),
		passphrase: passphraseSchema(i18n),
	});

export const UpdateSSHKeySchema = (i18n: I18n) =>
	z.object({
		id: z.uuid({ message: i18n._("ID is required") }),
		name: z
			.string()
			.min(1, { message: i18n._("Name is required") })
			.optional(),
		description: z.string().optional(),
		privateKey: z.string().optional(),
		publicKey: z.string().optional(),
		passphrase: passphraseSchema(i18n),
		/**
		 * Forget the stored passphrase (the key is, or is replaced by, an
		 * unencrypted one). Wins over `passphrase`; re-validated like any key
		 * change, so an encrypted key cannot lose its passphrase.
		 */
		clearPassphrase: z.boolean().optional(),
	});

/**
 * Generate a key pair on the server and store it: the private key never
 * travels to the browser (only via the audited reveal action).
 */
export const GenerateSSHKeySchema = (i18n: I18n) =>
	z.object({
		name: z.string().min(1, { message: i18n._("Name is required") }),
		description: z.string().optional(),
		keyType: z.enum(SSH_KEY_TYPES, {
			message: i18n._("Key type is required"),
		}),
	});
export type GenerateSSHKeyInput = z.infer<
	ReturnType<typeof GenerateSSHKeySchema>
>;

/**
 * Client-side validation of the edit form: the update fields without `id`,
 * which is not a form field (the form adds it to the payload). Validating
 * with `UpdateSSHKeySchema` itself would fail on the missing id with no
 * visible error, so the form would never submit.
 */
export const EditSSHKeyFormSchema = (i18n: I18n) =>
	UpdateSSHKeySchema(i18n).omit({ id: true });

export type SSHKeyInput = z.infer<ReturnType<typeof AddSSHKeySchema>>;
export type SSHKeyUpdatePayload = z.infer<
	ReturnType<typeof UpdateSSHKeySchema>
>;
export type SSHKeyUpdateInput = Omit<SSHKeyUpdatePayload, "id">;

type SSHKeyRow = typeof sshKeys.$inferSelect;
export type SSHKeyDTO = Omit<
	SSHKeyRow,
	"privateKeyEncrypted" | "passphraseEncrypted"
> & {
	/** A passphrase is stored (the key is encrypted); never the value. */
	hasPassphrase: boolean;
};
