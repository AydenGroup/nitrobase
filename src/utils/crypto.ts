import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
} from "node:crypto";
import { previousSecrets, requireSecret } from "./env";
import { internalError } from "./plain-errors";

// Secrets at rest (server passwords, SSH keys, app env, driver configs, ...)
// use AES-256-GCM. Changing ENCRYPTION_KEY makes every stored secret
// undecryptable unless `scripts/rotate-encryption-key.ts` re-encrypts them.
//
// Format: `v3:` + base64(iv 12 | tag 16 | ciphertext), key =
// HKDF-SHA256(ENCRYPTION_KEY, salt, info). The prefix versions the format
// (a future one can be told apart and migrated); salt and info are fixed
// literals, never derived from the brand: the key of a format must not
// change once values exist under it. After a rotation, `decrypt` falls back
// to ENCRYPTION_KEY_PREVIOUS (see `previousSecrets`).
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = "v3:";
const SALT = "nitrobase/secrets-at-rest";
const INFO = "aes-256-gcm/v3";

/** Key derived from a raw secret (ENCRYPTION_KEY or an old one). */
function deriveKey(secret: string): Buffer {
	return Buffer.from(hkdfSync("sha256", secret, SALT, INFO, 32));
}

/** Encrypts with `secret` and a fresh random IV. */
export function encryptWithSecret(secret: string, plaintext: string): string {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv, {
		authTagLength: AUTH_TAG_LENGTH,
	});
	const encrypted = Buffer.concat([
		cipher.update(plaintext, "utf-8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return `${PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
}

/**
 * Decrypts a value with `secret`. Throws if it has no format prefix, is
 * truncated, was tampered with, or was encrypted under another key (GCM
 * auth fails). The tag length is pinned so a shortened tag is never
 * accepted.
 */
export function decryptWithSecret(secret: string, encoded: string): string {
	if (!encoded.startsWith(PREFIX)) {
		throw internalError("Unknown encrypted value format");
	}
	const buf = Buffer.from(encoded.slice(PREFIX.length), "base64");
	if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
		throw internalError("Encrypted value is truncated");
	}
	const iv = buf.subarray(0, IV_LENGTH);
	const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
	const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
	const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), iv, {
		authTagLength: AUTH_TAG_LENGTH,
	});
	decipher.setAuthTag(tag);
	return (
		decipher.update(ciphertext, undefined, "utf-8") + decipher.final("utf-8")
	);
}

/** Encrypts with ENCRYPTION_KEY. */
export function encrypt(plaintext: string): string {
	return encryptWithSecret(requireSecret("ENCRYPTION_KEY"), plaintext);
}

/**
 * Inverse of `encrypt`. When the current key fails (GCM authentication),
 * each ENCRYPTION_KEY_PREVIOUS entry is tried,
 * so data written before a key rotation (e.g. `env.enc` in old backup
 * archives) can still be read. The first error is rethrown if none fits.
 */
export function decrypt(encoded: string): string {
	const current = requireSecret("ENCRYPTION_KEY");
	try {
		return decryptWithSecret(current, encoded);
	} catch (error) {
		for (const secret of previousSecrets()) {
			if (secret === current) continue;
			try {
				return decryptWithSecret(secret, encoded);
			} catch {
				// try the next one
			}
		}
		throw error;
	}
}
