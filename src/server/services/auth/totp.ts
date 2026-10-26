import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { internalError } from "#/utils/error.ts";

/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), SHA-1, 30 s steps, 6 digits:
 * what every authenticator app supports. Pure and tested against the RFC
 * vectors.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of buffer) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(text: string): Buffer {
	const clean = text.replace(/[\s=-]/g, "").toUpperCase();
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of clean) {
		const index = ALPHABET.indexOf(char);
		if (index === -1) throw internalError("Invalid base32");
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

export interface TotpOptions {
	digits?: number;
	algorithm?: "sha1" | "sha256" | "sha512";
}

export function hotp(
	secret: Buffer,
	counter: number,
	{ digits = 6, algorithm = "sha1" }: TotpOptions = {},
): string {
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac(algorithm, secret).update(message).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const binary =
		((digest[offset] & 0x7f) << 24) |
		(digest[offset + 1] << 16) |
		(digest[offset + 2] << 8) |
		digest[offset + 3];
	return String(binary % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238 time step (30 s). */
function timeStep(nowMs: number): number {
	return Math.floor(nowMs / 30_000);
}

export function totp(
	secret: Buffer,
	nowMs: number,
	options: TotpOptions = {},
): string {
	return hotp(secret, timeStep(nowMs), options);
}

function equal(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The time step a code matches within ±`window` steps, newer than
 * `lastStep` (a code is never accepted twice), or null.
 */
export function verifyTotp(
	secret: Buffer,
	code: string,
	options: {
		nowMs: number;
		window: number;
		lastStep?: number | null;
	} & TotpOptions,
): number | null {
	const digits = options.digits ?? 6;
	const normalized = code.replace(/\s/g, "");
	if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return null;
	const current = timeStep(options.nowMs);
	for (let delta = -options.window; delta <= options.window; delta++) {
		const step = current + delta;
		if (options.lastStep != null && step <= options.lastStep) continue;
		if (equal(hotp(secret, step, options), normalized)) return step;
	}
	return null;
}

/** 20 random bytes (160 bits, the RFC 4226 recommendation), base32. */
export function generateTotpSecret(): string {
	return base32Encode(randomBytes(20));
}

export function otpauthUri(input: {
	issuer: string;
	account: string;
	secret: string;
}): string {
	const label = encodeURIComponent(`${input.issuer}:${input.account}`);
	const params = new URLSearchParams({
		secret: input.secret,
		issuer: input.issuer,
		algorithm: "SHA1",
		digits: "6",
		period: "30",
	});
	return `otpauth://totp/${label}?${params.toString()}`;
}
