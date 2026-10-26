import { createHash } from "node:crypto";
import ssh2 from "ssh2";

// ssh2 is CommonJS; `utils` is not exposed as a named ESM export.
const { utils } = ssh2;

type ParsedKeyType = "rsa" | "ed25519";

export type SSHKeyErrorCode =
	| "SSH_KEY_INVALID"
	| "SSH_KEY_PASSPHRASE_REQUIRED"
	| "SSH_KEY_PASSPHRASE_INVALID"
	| "SSH_KEY_PASSPHRASE_UNEXPECTED"
	| "SSH_KEY_UNSUPPORTED"
	| "SSH_KEY_MISMATCH";

export class SSHKeyParseError extends Error {
	constructor(readonly code: SSHKeyErrorCode) {
		super(code);
		this.name = "SSHKeyParseError";
	}
}

export interface ParsedKeyPair {
	keyType: ParsedKeyType;
	/** OpenSSH public key line (`<type> <base64> [comment]`). */
	publicKey: string;
	/** `SHA256:<base64>`, identical to `ssh-keygen -lf`. */
	fingerprint: string;
}

const KEY_TYPES: Record<string, ParsedKeyType> = {
	"ssh-ed25519": "ed25519",
	"ssh-rsa": "rsa",
};

/** OpenSSH-style SHA256 fingerprint of a public key blob. */
export function fingerprintOf(blob: Buffer): string {
	const digest = createHash("sha256").update(blob).digest("base64");
	return `SHA256:${digest.replace(/=+$/, "")}`;
}

function parseOne(data: string, passphrase?: string) {
	const parsed = utils.parseKey(data, passphrase || undefined);
	if (parsed instanceof Error) {
		const message = parsed.message.toLowerCase();
		if (message.includes("no passphrase")) {
			throw new SSHKeyParseError("SSH_KEY_PASSPHRASE_REQUIRED");
		}
		if (
			passphrase &&
			(message.includes("passphrase") ||
				message.includes("decrypt") ||
				message.includes("bad"))
		) {
			throw new SSHKeyParseError("SSH_KEY_PASSPHRASE_INVALID");
		}
		throw new SSHKeyParseError("SSH_KEY_INVALID");
	}
	return Array.isArray(parsed) ? parsed[0] : parsed;
}

/**
 * Whether `privateKey` positively reads as a private key without any
 * passphrase (so a passphrase for it is meaningless). Fails closed: any
 * parse error, whatever its wording (encrypted, unsupported, garbage), is
 * "no", so callers never drop or refuse a passphrase on a guess.
 */
export function parsesWithoutPassphrase(privateKey: string): boolean {
	const parsed = utils.parseKey(privateKey.trim());
	const first = Array.isArray(parsed) ? parsed[0] : parsed;
	return !(first instanceof Error) && !!first?.isPrivateKey();
}

/**
 * Validate a private key (decrypting with `passphrase` when needed), derive
 * its type and public key, and check that a supplied public key matches.
 * An empty `publicKey` is derived from the private key. A passphrase for a
 * key that is not encrypted is refused (ssh2 would silently ignore it, and
 * it is usually a browser-autofilled password, never something to store).
 */
export function parseKeyPair(input: {
	privateKey: string;
	publicKey?: string;
	passphrase?: string;
}): ParsedKeyPair {
	const data = input.privateKey.trim();
	if (input.passphrase && parsesWithoutPassphrase(data)) {
		throw new SSHKeyParseError("SSH_KEY_PASSPHRASE_UNEXPECTED");
	}
	const privateKey = parseOne(data, input.passphrase);
	if (!privateKey?.isPrivateKey()) {
		throw new SSHKeyParseError("SSH_KEY_INVALID");
	}
	const keyType = KEY_TYPES[privateKey.type];
	if (!keyType) throw new SSHKeyParseError("SSH_KEY_UNSUPPORTED");

	const blob = privateKey.getPublicSSH();
	const derived = `${privateKey.type} ${blob.toString("base64")}`;
	const given = input.publicKey?.trim();

	let publicKey = privateKey.comment
		? `${derived} ${privateKey.comment}`
		: derived;
	if (given) {
		const publicParsed = parseOne(given);
		if (!publicParsed || !publicParsed.getPublicSSH().equals(blob)) {
			throw new SSHKeyParseError("SSH_KEY_MISMATCH");
		}
		publicKey = given;
	}

	return { keyType, publicKey, fingerprint: fingerprintOf(blob) };
}
