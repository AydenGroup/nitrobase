import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { opaqueChecksum, opaqueKey } from "./keys";
import {
	cryptoRandom,
	type RandomSource,
	referencedVariables,
	resolveVariables,
} from "./variables";

function seqRandom(start = 0): RandomSource {
	let n = start;
	return {
		bytes: (size) => Buffer.from(Array.from({ length: size }, () => n++ % 256)),
		uuid: () => "00000000-0000-4000-8000-000000000000",
	};
}

const builtins = { domain: "app.example.org", url: "https://app.example.org" };
const SECRET = "super-secret-jwt-key-with-32-chars!!";

const supabaseKeys = {
	JWT_SECRET: { value: SECRET },
	SUPABASE_PUBLISHABLE_KEY: {
		value: "${opaque_key:sb_publishable_:supabase-self-hosted}",
	},
	SUPABASE_SECRET_KEY: {
		value: "${opaque_key:sb_secret_:supabase-self-hosted}",
	},
	JWT_KEYS: { value: "${signing_keys:es256:JWT_SECRET}" },
	JWT_JWKS: { value: "${jwks:JWT_KEYS}" },
	ANON_KEY_ASYMMETRIC: { value: "${jwt_es256:JWT_KEYS:anon:supabase}" },
	SERVICE_ROLE_KEY_ASYMMETRIC: {
		value: "${jwt_es256:JWT_KEYS:service_role:supabase}",
	},
};

function decode(part: string) {
	return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** Verify an ES256 JWT against a JWKS the way a resource server would. */
function verifyWithJwks(
	token: string,
	jwks: { keys: Record<string, unknown>[] },
) {
	const [header, body, signature] = token.split(".");
	const { kid, alg } = decode(header);
	const jwk = jwks.keys.find((key) => key.kid === kid);
	if (!jwk || alg !== "ES256") return false;
	const key = createPublicKey({ key: jwk as never, format: "jwk" });
	return verify(
		"sha256",
		Buffer.from(`${header}.${body}`),
		{ key, dsaEncoding: "ieee-p1363" },
		Buffer.from(signature, "base64url"),
	);
}

describe("opaque_key", () => {
	it("follows upstream's format: prefix, 22 base64url chars, _ + 8-char checksum", () => {
		const out = resolveVariables(supabaseKeys, { builtins });
		for (const [name, prefix] of [
			["SUPABASE_PUBLISHABLE_KEY", "sb_publishable_"],
			["SUPABASE_SECRET_KEY", "sb_secret_"],
		] as const) {
			const value = out[name];
			const match = value.match(
				new RegExp(`^(${prefix}[A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{8})$`),
			);
			expect(match, value).not.toBeNull();
			const [, body, checksum] = match as RegExpMatchArray;
			// sha256("supabase-self-hosted|" + body), base64url, first 8.
			expect(checksum).toBe(
				createHash("sha256")
					.update(`supabase-self-hosted|${body}`)
					.digest("base64url")
					.slice(0, 8),
			);
		}
		expect(out.SUPABASE_PUBLISHABLE_KEY).not.toBe(out.SUPABASE_SECRET_KEY);
	});

	it("matches the upstream algorithm on known bytes", () => {
		const key = opaqueKey(seqRandom(), "sb_secret_", "supabase-self-hosted");
		const random = Buffer.from(Array.from({ length: 17 }, (_, i) => i))
			.toString("base64url")
			.slice(0, 22);
		expect(key).toBe(
			`sb_secret_${random}_${opaqueChecksum(`sb_secret_${random}`, "supabase-self-hosted")}`,
		);
	});

	it("is unique across calls with the crypto source", () => {
		const keys = new Set(
			Array.from({ length: 200 }, () =>
				opaqueKey(cryptoRandom, "sb_secret_", "supabase-self-hosted"),
			),
		);
		expect(keys.size).toBe(200);
	});

	it("rejects bad arguments", () => {
		for (const value of [
			"${opaque_key}",
			"${opaque_key:sb_secret_}",
			"${opaque_key:sb secret:ns}",
			"${opaque_key:sb_:ns:extra}",
			"${opaque_key:sb_:bad|ns}",
		]) {
			expect(() => resolveVariables({ K: { value } }, { builtins })).toThrow(
				/VARIABLE_GENERATOR_SYNTAX|Use/,
			);
		}
	});
});

describe("signing_keys / jwks / jwt_es256", () => {
	it("builds upstream's JWT_KEYS (EC private + legacy oct) and JWT_JWKS", () => {
		const out = resolveVariables(supabaseKeys, {
			builtins,
			now: 1_700_000_000,
		});
		const keys = JSON.parse(out.JWT_KEYS);
		expect(Array.isArray(keys)).toBe(true);
		expect(keys).toHaveLength(2);
		const [ec, oct] = keys;
		expect(ec).toMatchObject({
			kty: "EC",
			use: "sig",
			key_ops: ["sign", "verify"],
			alg: "ES256",
			ext: true,
			crv: "P-256",
		});
		expect(ec.kid).toMatch(/^[0-9a-f-]{36}$/);
		for (const field of ["x", "y", "d"]) {
			expect(Buffer.from(ec[field], "base64url")).toHaveLength(32);
		}
		expect(oct).toEqual({
			kty: "oct",
			k: Buffer.from(SECRET).toString("base64url"),
			alg: "HS256",
		});

		const jwks = JSON.parse(out.JWT_JWKS);
		expect(Object.keys(jwks)).toEqual(["keys"]);
		const [pub, pubOct] = jwks.keys;
		expect(pub).not.toHaveProperty("d");
		expect(pub).toMatchObject({
			kty: "EC",
			kid: ec.kid,
			key_ops: ["verify"],
			alg: "ES256",
			x: ec.x,
			y: ec.y,
		});
		expect(pubOct).toEqual(oct);
		// The public half is a valid P-256 key.
		expect(
			createPublicKey({ key: pub, format: "jwk" }).asymmetricKeyDetails,
		).toEqual({ namedCurve: "prime256v1" });
	});

	it("signs ES256 role JWTs that verify against the JWKS", () => {
		const out = resolveVariables(supabaseKeys, {
			builtins,
			now: 1_700_000_000,
		});
		const jwks = JSON.parse(out.JWT_JWKS);
		for (const [name, role] of [
			["ANON_KEY_ASYMMETRIC", "anon"],
			["SERVICE_ROLE_KEY_ASYMMETRIC", "service_role"],
		] as const) {
			const token = out[name];
			const [header, body] = token.split(".");
			expect(decode(header)).toEqual({
				alg: "ES256",
				typ: "JWT",
				kid: jwks.keys[0].kid,
			});
			expect(decode(body)).toEqual({
				role,
				iss: "supabase",
				iat: 1_700_000_000,
				exp: 1_700_000_000 + 10 * 365 * 24 * 60 * 60,
			});
			expect(verifyWithJwks(token, jwks)).toBe(true);
			// A tampered payload fails.
			const forged = `${header}.${Buffer.from(
				JSON.stringify({ role: "service_role" }),
			).toString("base64url")}.${token.split(".")[2]}`;
			expect(verifyWithJwks(forged, jwks)).toBe(false);
		}
	});

	it("generates a fresh key pair with the crypto source", () => {
		const a = JSON.parse(
			resolveVariables(supabaseKeys, { builtins }).JWT_KEYS,
		)[0];
		const b = JSON.parse(
			resolveVariables(supabaseKeys, { builtins }).JWT_KEYS,
		)[0];
		expect(a.d).not.toBe(b.d);
		expect(a.kid).not.toBe(b.kid);
	});

	it("is deterministic with a seeded source and rejects out-of-range scalars", () => {
		// The first 32 bytes are all 0xff (>= the curve order): skipped.
		let calls = 0;
		const random: RandomSource = {
			bytes: (size) =>
				calls++ === 0 ? Buffer.alloc(size, 0xff) : seqRandom(1).bytes(size),
			uuid: () => "00000000-0000-4000-8000-000000000000",
		};
		const keys = JSON.parse(
			resolveVariables(
				{ K: { value: "${signing_keys:es256}" } },
				{ builtins, random },
			).K,
		);
		expect(keys).toHaveLength(1);
		expect(Buffer.from(keys[0].d, "base64url")).toEqual(seqRandom(1).bytes(32));
	});

	it("never puts a private EC part in JWT_JWKS", () => {
		for (let i = 0; i < 5; i++) {
			const { JWT_JWKS } = resolveVariables(supabaseKeys, { builtins });
			const ec = JSON.parse(JWT_JWKS).keys.filter(
				(key: { kty: string }) => key.kty === "EC",
			);
			expect(ec).toHaveLength(1);
			expect(ec[0]).not.toHaveProperty("d");
			expect(ec[0].key_ops).toEqual(["verify"]);
		}
	});

	it("keeps existing keys and re-derives the JWKS from them", () => {
		const first = resolveVariables(supabaseKeys, { builtins });
		const again = resolveVariables(supabaseKeys, {
			builtins,
			existing: {
				JWT_KEYS: first.JWT_KEYS,
				ANON_KEY_ASYMMETRIC: first.ANON_KEY_ASYMMETRIC,
			},
		});
		expect(again.JWT_JWKS).toBe(first.JWT_JWKS);
		expect(again.ANON_KEY_ASYMMETRIC).toBe(first.ANON_KEY_ASYMMETRIC);
		expect(
			verifyWithJwks(
				again.SERVICE_ROLE_KEY_ASYMMETRIC,
				JSON.parse(again.JWT_JWKS),
			),
		).toBe(true);
	});

	it("reports dependencies for ordering and rotation", () => {
		expect(referencedVariables("${signing_keys:es256:JWT_SECRET}")).toEqual([
			"JWT_SECRET",
		]);
		expect(referencedVariables("${signing_keys:es256}")).toEqual([]);
		expect(referencedVariables("${jwks:JWT_KEYS}")).toEqual(["JWT_KEYS"]);
		expect(referencedVariables("${jwt_es256:JWT_KEYS:anon}")).toEqual([
			"JWT_KEYS",
		]);
		expect(referencedVariables("${opaque_key:sb_secret_:ns}")).toEqual([]);
	});

	it("rejects bad expressions and key sets", () => {
		const bad: Record<string, { value: string }>[] = [
			{ K: { value: "${signing_keys}" } },
			{ K: { value: "${signing_keys:rs999}" } },
			{ K: { value: "${jwks}" } },
			{ K: { value: "${jwks:A:B}" } },
			{ A: { value: "not json" }, K: { value: "${jwks:A}" } },
			{ A: { value: '{"keys":[1]}' }, K: { value: "${jwks:A}" } },
			{ K: { value: "${jwt_es256:A}" } },
			{
				A: { value: '[{"kty":"oct","k":"eA","alg":"HS256"}]' },
				K: { value: "${jwt_es256:A:anon}" },
			},
		];
		for (const definitions of bad) {
			expect(() => resolveVariables(definitions, { builtins })).toThrow();
		}
		expect(() =>
			resolveVariables({ K: { value: "${jwks:MISSING}" } }, { builtins }),
		).toThrow();
	});
});
