import { describe, expect, it } from "vitest";
import {
	generateRecoveryCodes,
	hashRecoveryCode,
	looksLikeRecoveryCode,
} from "./recovery";
import {
	base32Decode,
	base32Encode,
	hotp,
	otpauthUri,
	totp,
	verifyTotp,
} from "./totp";

// RFC 6238 Appendix B (seeds per algorithm, 8 digits).
const seeds = {
	sha1: Buffer.from("12345678901234567890"),
	sha256: Buffer.from("12345678901234567890123456789012"),
	sha512: Buffer.from(
		"1234567890123456789012345678901234567890123456789012345678901234",
	),
};
const vectors: [number, string, string, string][] = [
	[59, "94287082", "46119246", "90693936"],
	[1111111109, "07081804", "68084774", "25091201"],
	[1111111111, "14050471", "67062674", "99943326"],
	[1234567890, "89005924", "91819424", "93441116"],
	[2000000000, "69279037", "90698825", "38618901"],
	[20000000000, "65353130", "77737706", "47863826"],
];

describe("TOTP (RFC 6238)", () => {
	it.each(vectors)("t=%i", (seconds, sha1, sha256, sha512) => {
		const now = seconds * 1000;
		expect(totp(seeds.sha1, now, { digits: 8 })).toBe(sha1);
		expect(totp(seeds.sha256, now, { digits: 8, algorithm: "sha256" })).toBe(
			sha256,
		);
		expect(totp(seeds.sha512, now, { digits: 8, algorithm: "sha512" })).toBe(
			sha512,
		);
	});

	it("matches the RFC 4226 HOTP vectors", () => {
		const expected = ["755224", "287082", "359152", "969429", "338314"];
		expected.forEach((code, counter) => {
			expect(hotp(seeds.sha1, counter)).toBe(code);
		});
	});

	it("round-trips base32", () => {
		const encoded = base32Encode(seeds.sha1);
		expect(encoded).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
		expect(base32Decode(encoded.toLowerCase())).toEqual(seeds.sha1);
		expect(() => base32Decode("01")).toThrow();
	});

	it("accepts ±window steps, never the same or an older step twice", () => {
		const now = 1111111109 * 1000;
		const step = Math.floor(1111111109 / 30);
		const code = totp(seeds.sha1, now);
		const opts = { nowMs: now, window: 1 };
		expect(verifyTotp(seeds.sha1, code, opts)).toBe(step);
		expect(verifyTotp(seeds.sha1, totp(seeds.sha1, now - 30_000), opts)).toBe(
			step - 1,
		);
		expect(verifyTotp(seeds.sha1, totp(seeds.sha1, now - 90_000), opts)).toBe(
			null,
		);
		expect(verifyTotp(seeds.sha1, code, { ...opts, lastStep: step })).toBe(
			null,
		);
		expect(verifyTotp(seeds.sha1, "12345", opts)).toBe(null);
		expect(verifyTotp(seeds.sha1, "abcdef", opts)).toBe(null);
	});

	it("builds an otpauth URI", () => {
		expect(
			otpauthUri({ issuer: "Nitrobase", account: "a@b.c", secret: "ABC" }),
		).toBe(
			"otpauth://totp/Nitrobase%3Aa%40b.c?secret=ABC&issuer=Nitrobase&algorithm=SHA1&digits=6&period=30",
		);
	});
});

describe("recovery codes", () => {
	it("are unique, well formed and hash the same with or without formatting", () => {
		const codes = generateRecoveryCodes(10);
		expect(new Set(codes).size).toBe(10);
		for (const code of codes) {
			expect(code).toMatch(/^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
			expect(looksLikeRecoveryCode(code)).toBe(true);
		}
		const [first] = codes;
		expect(hashRecoveryCode(first.toLowerCase().replace("-", " "))).toBe(
			hashRecoveryCode(first),
		);
		expect(looksLikeRecoveryCode("123456")).toBe(false);
	});
});
