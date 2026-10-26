import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * Encryption compatible with
 *   openssl enc -aes-256-cbc -pbkdf2 -md sha256 -iter <N> -salt
 * so a self-backup can be decrypted with stock openssl and the instance's
 * ENCRYPTION_KEY during disaster recovery (no Nitrobase needed). Pure.
 */
const MAGIC = Buffer.from("Salted__");

export function opensslEncrypt(
	data: Buffer,
	password: string,
	iterations: number,
): Buffer {
	const salt = randomBytes(8);
	const derived = pbkdf2Sync(password, salt, iterations, 48, "sha256");
	const cipher = createCipheriv(
		"aes-256-cbc",
		derived.subarray(0, 32),
		derived.subarray(32, 48),
	);
	return Buffer.concat([MAGIC, salt, cipher.update(data), cipher.final()]);
}
