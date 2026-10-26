import { createHash, randomInt } from "node:crypto";

/** Unambiguous characters (no 0/O, 1/I/L). */
const CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** `XXXXX-XXXXX` (≈49 bits each): shown once, stored hashed. */
export function generateRecoveryCodes(count: number): string[] {
	return Array.from({ length: count }, () => {
		let raw = "";
		for (let i = 0; i < 10; i++) raw += CHARS[randomInt(CHARS.length)];
		return `${raw.slice(0, 5)}-${raw.slice(5)}`;
	});
}

function normalizeRecoveryCode(code: string): string {
	return code.replace(/[\s-]/g, "").toUpperCase();
}

export function looksLikeRecoveryCode(code: string): boolean {
	return /^[2-9A-HJKMNP-Z]{10}$/.test(normalizeRecoveryCode(code));
}

/** High-entropy random codes: a plain sha256 is enough (no brute force). */
export function hashRecoveryCode(code: string): string {
	return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}
