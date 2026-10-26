import { createECDH, createHash, createPrivateKey, sign } from "node:crypto";
import { TemplateError } from "./naming";

/**
 * Key material for template variable generators: checksummed opaque API
 * keys, signing key sets (JWK) and asymmetric JWTs. Randomness always comes
 * from the caller's source (crypto RNG in production, seeded in tests).
 */

export interface KeyRandom {
	bytes(size: number): Buffer;
	uuid(): string;
}

const base64url = (input: Buffer | string) =>
	Buffer.from(input).toString("base64url");

// ---------------------------------------------------------------------------
// Opaque API keys

/**
 * Random part: 17 random bytes -> base64url, first 22 characters (22 x 6 =
 * 132 bits of randomness), exactly upstream's `add-new-auth-keys.sh` format.
 */
const OPAQUE_RANDOM_BYTES = 17;
const OPAQUE_RANDOM_LENGTH = 22;
const OPAQUE_CHECKSUM_LENGTH = 8;

export const OPAQUE_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
export const OPAQUE_NAMESPACE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * `<prefix><22 random base64url chars>_<8-char checksum>`, the checksum being
 * the first 8 base64url characters of SHA-256(`<namespace>|<prefix><random>`)
 * (the format of Supabase's `sb_publishable_…` / `sb_secret_…` keys).
 */
export function opaqueKey(
	random: KeyRandom,
	prefix: string,
	namespace: string,
): string {
	const body = `${prefix}${random
		.bytes(OPAQUE_RANDOM_BYTES)
		.toString("base64url")
		.slice(0, OPAQUE_RANDOM_LENGTH)}`;
	return `${body}_${opaqueChecksum(body, namespace)}`;
}

export function opaqueChecksum(body: string, namespace: string): string {
	return createHash("sha256")
		.update(`${namespace}|${body}`)
		.digest("base64url")
		.slice(0, OPAQUE_CHECKSUM_LENGTH);
}

// ---------------------------------------------------------------------------
// JWK signing key sets

export interface Jwk {
	kty: string;
	kid?: string;
	alg?: string;
	use?: string;
	key_ops?: string[];
	ext?: boolean;
	crv?: string;
	x?: string;
	y?: string;
	d?: string;
	k?: string;
}

/** Order of the P-256 group (valid private scalars are 1..n-1). */
const P256_ORDER = BigInt(
	"0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);

/**
 * ES256 private JWK with a random key id. The private scalar comes from
 * `random` (rejection-sampled into the curve order) so generation follows
 * the variable engine's random source.
 */
function es256PrivateJwk(random: KeyRandom): Jwk {
	let d = random.bytes(32);
	for (
		let scalar = BigInt(`0x${d.toString("hex")}`);
		scalar === 0n || scalar >= P256_ORDER;
		scalar = BigInt(`0x${d.toString("hex")}`)
	) {
		d = random.bytes(32);
	}
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(d);
	const point = ecdh.getPublicKey(); // 0x04 || x || y
	return {
		kty: "EC",
		kid: random.uuid(),
		use: "sig",
		key_ops: ["sign", "verify"],
		alg: "ES256",
		ext: true,
		crv: "P-256",
		x: base64url(point.subarray(1, 33)),
		y: base64url(point.subarray(33, 65)),
		d: base64url(d),
	};
}

/** Supported `signing_keys` algorithms (asymmetric key generators). */
export const SIGNING_KEY_ALGORITHMS: Record<
	string,
	(random: KeyRandom) => Jwk
> = {
	es256: es256PrivateJwk,
};

/** A shared HS256 secret as a symmetric JWK. */
export function symmetricJwk(secret: string): Jwk {
	return { kty: "oct", k: base64url(secret), alg: "HS256" };
}

/** Parse a key set: a JSON array of JWKs or a JWKS object `{ keys }`. */
export function parseKeySet(value: string, name: string): Jwk[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TemplateError("VARIABLE_KEYS_INVALID", { name });
	}
	const keys = Array.isArray(parsed)
		? parsed
		: (parsed as { keys?: unknown } | null)?.keys;
	if (
		!Array.isArray(keys) ||
		!keys.every(
			(key) =>
				typeof key === "object" &&
				key !== null &&
				typeof (key as Jwk).kty === "string",
		)
	) {
		throw new TemplateError("VARIABLE_KEYS_INVALID", { name });
	}
	return keys as Jwk[];
}

/**
 * Verification key set (`{ keys }`) of a signing key set: asymmetric keys
 * lose their private part and may only verify; symmetric keys are kept
 * (verifiers of legacy HS256 tokens need them), so the result is secret
 * whenever the input holds a symmetric key.
 */
export function verificationKeySet(keys: Jwk[]): { keys: Jwk[] } {
	return {
		keys: keys.map((key) => {
			if (key.kty === "oct") return key;
			const { d: _private, ...pub } = key;
			return { ...pub, key_ops: ["verify"] };
		}),
	};
}

/** First asymmetric private key of a set (the one `jwt_es256` signs with). */
export function firstPrivateKey(keys: Jwk[], alg: string): Jwk | undefined {
	return keys.find((key) => key.alg === alg && key.kty !== "oct" && key.d);
}

/** ES256 JWT (header carries the key id) signed with a private JWK. */
export function signES256Jwt(
	jwk: Jwk,
	payload: Record<string, unknown>,
): string {
	const header = base64url(
		JSON.stringify({
			alg: "ES256",
			typ: "JWT",
			...(jwk.kid ? { kid: jwk.kid } : {}),
		}),
	);
	const body = base64url(JSON.stringify(payload));
	const key = createPrivateKey({
		key: { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
		format: "jwk",
	});
	const signature = sign("sha256", Buffer.from(`${header}.${body}`), {
		key,
		dsaEncoding: "ieee-p1363",
	}).toString("base64url");
	return `${header}.${body}.${signature}`;
}
