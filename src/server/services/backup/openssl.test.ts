import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { opensslEncrypt } from "./openssl";

/** What `openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -iter <N>` does. */
function opensslDecrypt(data: Buffer, password: string, iterations: number) {
	const salt = data.subarray(8, 16);
	const derived = pbkdf2Sync(password, salt, iterations, 48, "sha256");
	const decipher = createDecipheriv(
		"aes-256-cbc",
		derived.subarray(0, 32),
		derived.subarray(32, 48),
	);
	return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
}

describe("openssl-compatible encryption", () => {
	it("round-trips and uses the openssl salted format", () => {
		const data = Buffer.from("panel dump");
		const out = opensslEncrypt(data, "key-of-32-characters-at-least-xx", 1000);
		expect(out.subarray(0, 8).toString()).toBe("Salted__");
		expect(
			opensslDecrypt(out, "key-of-32-characters-at-least-xx", 1000),
		).toEqual(data);
		expect(() => opensslDecrypt(out, "wrong", 1000)).toThrow();
	});
});
