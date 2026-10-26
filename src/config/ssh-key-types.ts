/**
 * SSH key types and server auth methods (client-safe; the DB enums are built
 * from these lists, so adding a type also needs a migration). Kept free of
 * Lingui macros because drizzle-kit loads this file; translated labels of
 * auth methods live in `#/config/server-auth-methods.ts`.
 */

export interface SSHKeyTypeDefinition {
	/** Display name (algorithm names are not translated). */
	label: string;
	/** `ssh-keygen` arguments selecting the algorithm and size. */
	keygenArgs: readonly string[];
	/** Offered first when generating a key. */
	recommended?: boolean;
}

// Entry order is the DB enum order: append new types, never reorder.
export const sshKeyTypes = {
	rsa: { label: "RSA 4096", keygenArgs: ["-t", "rsa", "-b", "4096"] },
	ed25519: {
		label: "ED25519",
		keygenArgs: ["-t", "ed25519"],
		recommended: true,
	},
} as const satisfies Record<string, SSHKeyTypeDefinition>;

export type SSHKeyType = keyof typeof sshKeyTypes;
export const SSH_KEY_TYPES = Object.keys(sshKeyTypes) as [
	SSHKeyType,
	...SSHKeyType[],
];
/** Type preselected when generating a key. */
export const DEFAULT_SSH_KEY_TYPE: SSHKeyType =
	(Object.entries(sshKeyTypes) as [SSHKeyType, SSHKeyTypeDefinition][]).find(
		([, definition]) => definition.recommended,
	)?.[0] ?? SSH_KEY_TYPES[0];

export const SERVER_AUTH_METHODS = ["password", "private_key"] as const;
export type ServerAuthMethod = (typeof SERVER_AUTH_METHODS)[number];

/**
 * Longest accepted key passphrase (form and server). Generous for real
 * passphrases; bounds what is decrypted and stored.
 */
export const SSH_KEY_PASSPHRASE_MAX_LENGTH = 1024;
