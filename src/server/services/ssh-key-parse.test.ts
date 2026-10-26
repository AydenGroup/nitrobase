import ssh2 from "ssh2";

// ssh2 is CommonJS; `utils` is not exposed as a named ESM export.
const { utils } = ssh2;

import { describe, expect, it } from "vitest";
import {
	fingerprintOf,
	parseKeyPair,
	parsesWithoutPassphrase,
} from "./ssh-key-parse";

const ed = utils.generateKeyPairSync("ed25519", { comment: "me@laptop" });
const rsa = utils.generateKeyPairSync("rsa", { bits: 2048 });
const encrypted = utils.generateKeyPairSync("ed25519", {
	passphrase: "s3cret",
	cipher: "aes256-ctr",
	rounds: 4,
});
const ecdsa = utils.generateKeyPairSync("ecdsa", { bits: 256 });

const code = (fn: () => unknown) => {
	try {
		fn();
		return "ok";
	} catch (error) {
		return (error as { code?: string }).code ?? "unknown";
	}
};

describe("parseKeyPair", () => {
	it("derives type, public key and an ssh-keygen style fingerprint", () => {
		const parsed = parseKeyPair({ privateKey: ed.private });
		expect(parsed.keyType).toBe("ed25519");
		expect(parsed.publicKey.startsWith("ssh-ed25519 AAAA")).toBe(true);
		expect(parsed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
	});

	it("detects RSA regardless of the selected type", () => {
		expect(
			parseKeyPair({ privateKey: rsa.private, publicKey: rsa.public }).keyType,
		).toBe("rsa");
	});

	it("keeps a matching user-supplied public key", () => {
		expect(
			parseKeyPair({ privateKey: ed.private, publicKey: ed.public }).publicKey,
		).toBe(ed.public.trim());
	});

	it("rejects mismatched, invalid and unsupported keys", () => {
		expect(
			code(() =>
				parseKeyPair({ privateKey: ed.private, publicKey: rsa.public }),
			),
		).toBe("SSH_KEY_MISMATCH");
		expect(
			code(() => parseKeyPair({ privateKey: "not a key", publicKey: "hello" })),
		).toBe("SSH_KEY_INVALID");
		expect(code(() => parseKeyPair({ privateKey: ed.public }))).toBe(
			"SSH_KEY_INVALID",
		);
		expect(code(() => parseKeyPair({ privateKey: ecdsa.private }))).toBe(
			"SSH_KEY_UNSUPPORTED",
		);
	});

	it("handles encrypted keys", () => {
		expect(code(() => parseKeyPair({ privateKey: encrypted.private }))).toBe(
			"SSH_KEY_PASSPHRASE_REQUIRED",
		);
		expect(
			code(() =>
				parseKeyPair({ privateKey: encrypted.private, passphrase: "nope" }),
			),
		).toBe("SSH_KEY_PASSPHRASE_INVALID");
		expect(
			parseKeyPair({ privateKey: encrypted.private, passphrase: "s3cret" })
				.keyType,
		).toBe("ed25519");
	});
});

describe("passphrase for an unencrypted key (BUG-001)", () => {
	it("is refused with a coded error, not silently accepted", () => {
		expect(
			code(() =>
				parseKeyPair({ privateKey: ed.private, passphrase: "QaAdmin#2026" }),
			),
		).toBe("SSH_KEY_PASSPHRASE_UNEXPECTED");
		expect(
			code(() =>
				parseKeyPair({
					privateKey: rsa.private,
					publicKey: rsa.public,
					passphrase: "autofilled",
				}),
			),
		).toBe("SSH_KEY_PASSPHRASE_UNEXPECTED");
	});

	it("keeps the invalid-key answer for input that is not a private key", () => {
		expect(
			code(() => parseKeyPair({ privateKey: ed.public, passphrase: "x" })),
		).toBe("SSH_KEY_INVALID");
	});

	it("only says yes for a key that positively parses without one", () => {
		expect(parsesWithoutPassphrase(ed.private)).toBe(true);
		expect(parsesWithoutPassphrase(rsa.private)).toBe(true);
		expect(parsesWithoutPassphrase(encrypted.private)).toBe(false);
		expect(parsesWithoutPassphrase(ed.public)).toBe(false);
		expect(parsesWithoutPassphrase("not a key")).toBe(false);
	});
});

describe("fingerprintOf", () => {
	it("strips base64 padding", () => {
		expect(fingerprintOf(Buffer.from("abc"))).not.toContain("=");
	});
});
