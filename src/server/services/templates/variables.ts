import { createHmac, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import {
	firstPrivateKey,
	OPAQUE_NAMESPACE_PATTERN,
	OPAQUE_PREFIX_PATTERN,
	opaqueKey,
	parseKeySet,
	SIGNING_KEY_ALGORITHMS,
	signES256Jwt,
	symmetricJwk,
	verificationKeySet,
} from "./keys";
import { ENV_NAME_PATTERN, TemplateError } from "./naming";

// The `.env` format is shared with the client (env editor).
export { parseEnvFile, renderEnvFile } from "#/libs/env-file.ts";

/**
 * Template variable expressions (inside `${...}`):
 * - `password:N`   N random alphanumeric characters
 * - `base64:N`     N random bytes, base64
 * - `hex:N`        N random bytes, hex (2N characters)
 * - `uuid`         random UUID v4
 * - `jwt:VAR:role[:issuer]` HS256 JWT signed with variable VAR (`iss` only when given)
 * - `bcrypt:VAR[:cost]` bcrypt hash of variable VAR (e.g. a pre-hashed admin password)
 * - `opaque_key:PREFIX:NAMESPACE` checksummed opaque API key (Supabase format)
 * - `signing_keys:ALG[:SECRET_VAR]` JSON array of private signing JWKs: a new
 *   ALG key pair (es256), plus SECRET_VAR as a symmetric HS256 key when given
 * - `jwks:VAR`     verification key set `{ keys }` of the signing keys in VAR
 * - `jwt_es256:VAR:role[:issuer]` ES256 JWT signed with VAR's first private key
 * - `VAR`          value of another variable (UPPER_CASE)
 * - builtin        lowercase context value: domain, url, version, version_number, app_id, app_name, folder
 * `$$` produces a literal `$`.
 */

export interface RandomSource {
	bytes(size: number): Buffer;
	uuid(): string;
}

export const cryptoRandom: RandomSource = {
	bytes: (size) => randomBytes(size),
	uuid: () => randomUUID(),
};

export interface VariableDefinition {
	value: string;
}

export interface ResolveOptions {
	builtins: Record<string, string>;
	/** User-provided values (already validated as editable by the caller). */
	overrides?: Record<string, string>;
	/** Values from a previous deployment: kept so secrets aren't regenerated. */
	existing?: Record<string, string>;
	random?: RandomSource;
	/** Seconds since epoch used for JWT `iat`. */
	now?: number;
}

const MAX_LENGTH = 512;
const ALPHANUMERIC =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TEN_YEARS = 10 * 365 * 24 * 60 * 60;
const BCRYPT_COST = 10;

type Token = { kind: "text"; text: string } | { kind: "expr"; expr: string };

export function tokenize(template: string): Token[] {
	const tokens: Token[] = [];
	let text = "";
	for (let i = 0; i < template.length; i++) {
		const char = template[i];
		if (char === "$" && template[i + 1] === "$") {
			text += "$";
			i++;
			continue;
		}
		if (char === "$" && template[i + 1] === "{") {
			const end = template.indexOf("}", i + 2);
			if (end === -1)
				throw new TemplateError("VARIABLE_UNCLOSED", {
					template,
					opening: "${",
				});
			if (text) tokens.push({ kind: "text", text });
			text = "";
			tokens.push({ kind: "expr", expr: template.slice(i + 2, end).trim() });
			i = end;
			continue;
		}
		text += char;
	}
	if (text) tokens.push({ kind: "text", text });
	return tokens;
}

function sizeArg(expr: string, raw: string | undefined): number {
	const size = Number(raw);
	if (!Number.isInteger(size) || size < 1 || size > MAX_LENGTH) {
		throw new TemplateError("VARIABLE_SIZE_INVALID", {
			expression: `\${${expr}}`,
			max: MAX_LENGTH,
		});
	}
	return size;
}

function randomAlphanumeric(random: RandomSource, length: number): string {
	// Rejection sampling keeps the distribution uniform.
	let out = "";
	const limit = 256 - (256 % ALPHANUMERIC.length);
	while (out.length < length) {
		for (const byte of random.bytes(length * 2)) {
			if (byte < limit) out += ALPHANUMERIC[byte % ALPHANUMERIC.length];
			if (out.length === length) break;
		}
	}
	return out;
}

const base64url = (input: Buffer | string) =>
	Buffer.from(input).toString("base64url");

export function signHS256Jwt(
	secret: string,
	payload: Record<string, unknown>,
): string {
	const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = base64url(JSON.stringify(payload));
	const signature = createHmac("sha256", secret)
		.update(`${header}.${body}`)
		.digest("base64url");
	return `${header}.${body}.${signature}`;
}

/** Generators whose first argument is another variable. */
const KEY_REFERENCE_KINDS = new Set(["jwt", "bcrypt", "jwks", "jwt_es256"]);

/** Variables referenced by a definition (for dependency ordering). */
export function referencedVariables(template: string): string[] {
	const refs: string[] = [];
	for (const token of tokenize(template)) {
		if (token.kind !== "expr") continue;
		const [head, arg, extra] = token.expr.split(":");
		if (KEY_REFERENCE_KINDS.has(head) && arg) refs.push(arg);
		else if (head === "signing_keys" && extra) refs.push(extra);
		else if (ENV_NAME_PATTERN.test(head) && !token.expr.includes(":")) {
			refs.push(head);
		}
	}
	return refs;
}

/**
 * Resolve all variables in declaration order (dependencies first).
 * Throws TemplateError on unknown references, bad expressions and cycles.
 */
export function resolveVariables(
	definitions: Record<string, VariableDefinition>,
	options: ResolveOptions,
): Record<string, string> {
	const random = options.random ?? cryptoRandom;
	const now = options.now ?? Math.floor(Date.now() / 1000);
	const resolved: Record<string, string> = {};
	const state = new Map<string, "visiting" | "done">();

	const evaluate = (name: string, template: string, stack: string[]) => {
		let out = "";
		for (const token of tokenize(template)) {
			if (token.kind === "text") {
				out += token.text;
				continue;
			}
			const { expr } = token;
			const [head, ...args] = expr.split(":");
			if (head === "password")
				out += randomAlphanumeric(random, sizeArg(expr, args[0]));
			else if (head === "base64")
				out += random.bytes(sizeArg(expr, args[0])).toString("base64");
			else if (head === "hex")
				out += random.bytes(sizeArg(expr, args[0])).toString("hex");
			else if (head === "uuid" && args.length === 0) out += random.uuid();
			else if (head === "jwt") {
				const [secretVar, role, issuer] = args;
				if (
					!secretVar ||
					!role ||
					args.length > 3 ||
					(issuer !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(issuer))
				) {
					throw new TemplateError("VARIABLE_JWT_SYNTAX", {
						name,
						short: `\${jwt:SECRET_VAR:role}`,
						long: `\${jwt:SECRET_VAR:role:issuer}`,
					});
				}
				const secret = visit(secretVar, [...stack, name]);
				out += signHS256Jwt(secret, {
					role,
					...(issuer ? { iss: issuer } : {}),
					iat: now,
					exp: now + TEN_YEARS,
				});
			} else if (head === "bcrypt") {
				const [sourceVar, rawCost] = args;
				const cost = rawCost === undefined ? BCRYPT_COST : Number(rawCost);
				if (
					!sourceVar ||
					args.length > 2 ||
					!Number.isInteger(cost) ||
					cost < 4 ||
					cost > 14
				) {
					throw new TemplateError("VARIABLE_BCRYPT_SYNTAX", {
						name,
						short: `\${bcrypt:VAR}`,
						long: `\${bcrypt:VAR:cost}`,
					});
				}
				const password = visit(sourceVar, [...stack, name]);
				// Salt from the random source (deterministic in tests).
				const salt = `$2b$${String(cost).padStart(2, "0")}$${bcrypt.encodeBase64(random.bytes(16), 16)}`;
				out += bcrypt.hashSync(password, salt);
			} else if (head === "opaque_key") {
				const [prefix, namespace] = args;
				if (
					args.length !== 2 ||
					!OPAQUE_PREFIX_PATTERN.test(prefix) ||
					!OPAQUE_NAMESPACE_PATTERN.test(namespace)
				) {
					throw new TemplateError("VARIABLE_GENERATOR_SYNTAX", {
						name,
						short: `\${opaque_key:PREFIX:NAMESPACE}`,
						long: `\${opaque_key:sb_secret_:supabase-self-hosted}`,
					});
				}
				out += opaqueKey(random, prefix, namespace);
			} else if (head === "signing_keys") {
				const [alg, secretVar] = args;
				const generate = alg ? SIGNING_KEY_ALGORITHMS[alg] : undefined;
				if (!generate || args.length > 2 || (args.length === 2 && !secretVar)) {
					throw new TemplateError("VARIABLE_GENERATOR_SYNTAX", {
						name,
						short: `\${signing_keys:${Object.keys(SIGNING_KEY_ALGORITHMS).join("|")}}`,
						long: `\${signing_keys:es256:SECRET_VAR}`,
					});
				}
				const keys = [generate(random)];
				if (secretVar) {
					keys.push(symmetricJwk(visit(secretVar, [...stack, name])));
				}
				out += JSON.stringify(keys);
			} else if (head === "jwks") {
				const [keysVar] = args;
				if (!keysVar || args.length !== 1) {
					throw new TemplateError("VARIABLE_JWKS_SYNTAX", {
						name,
						short: `\${jwks:KEYS_VAR}`,
					});
				}
				const keys = parseKeySet(visit(keysVar, [...stack, name]), keysVar);
				out += JSON.stringify(verificationKeySet(keys));
			} else if (head === "jwt_es256") {
				const [keysVar, role, issuer] = args;
				if (
					!keysVar ||
					!role ||
					args.length > 3 ||
					(issuer !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(issuer))
				) {
					throw new TemplateError("VARIABLE_GENERATOR_SYNTAX", {
						name,
						short: `\${jwt_es256:KEYS_VAR:role}`,
						long: `\${jwt_es256:KEYS_VAR:role:issuer}`,
					});
				}
				const keys = parseKeySet(visit(keysVar, [...stack, name]), keysVar);
				const key = firstPrivateKey(keys, "ES256");
				if (!key) {
					throw new TemplateError("VARIABLE_KEYS_NO_PRIVATE", {
						name: keysVar,
						alg: "ES256",
					});
				}
				out += signES256Jwt(key, {
					role,
					...(issuer ? { iss: issuer } : {}),
					iat: now,
					exp: now + TEN_YEARS,
				});
			} else if (args.length === 0 && head in options.builtins) {
				out += options.builtins[head];
			} else if (args.length === 0 && ENV_NAME_PATTERN.test(head)) {
				out += visit(head, [...stack, name]);
			} else {
				throw new TemplateError("VARIABLE_UNKNOWN_EXPRESSION", {
					expression: `\${${expr}}`,
					name,
				});
			}
		}
		return out;
	};

	const visit = (name: string, stack: string[]): string => {
		if (state.get(name) === "done") return resolved[name];
		if (!(name in definitions)) {
			const from = stack.at(-1);
			if (from) {
				throw new TemplateError("VARIABLE_UNKNOWN_REFERENCE", { from, name });
			}
			throw new TemplateError("VARIABLE_UNKNOWN", { name });
		}
		if (state.get(name) === "visiting") {
			throw new TemplateError("VARIABLE_CYCLE", {
				cycle: [...stack.slice(stack.indexOf(name)), name].join(" -> "),
			});
		}
		state.set(name, "visiting");
		const value =
			options.overrides?.[name] ??
			options.existing?.[name] ??
			evaluate(name, definitions[name].value, stack);
		resolved[name] = value;
		state.set(name, "done");
		return value;
	};

	for (const name of Object.keys(definitions)) {
		if (!ENV_NAME_PATTERN.test(name)) {
			throw new TemplateError("VARIABLE_NAME_INVALID", { name });
		}
		visit(name, []);
	}
	// Keep declaration order in the output.
	return Object.fromEntries(
		Object.keys(definitions).map((name) => [name, resolved[name]]),
	);
}

const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
	"\\": "\\",
	'"': '"',
	$: "$",
	r: "\r",
	n: "\n",
};

/**
 * Exact inverse of `renderEnvFile` (a `.env` Nitrobase wrote, e.g. read back
 * from the server): `'…'` is literal, `"…"` undoes exactly the escapes
 * `renderEnvFile` writes, in one pass. Lines in another shape are skipped.
 */
export function parseRenderedEnvFile(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) continue;
		const raw = match[2];
		if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
			out[match[1]] = raw.slice(1, -1);
		} else if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
			out[match[1]] = raw
				.slice(1, -1)
				.replace(
					/\\(["\\$rn])/g,
					(_, char: string) => DOUBLE_QUOTED_ESCAPES[char],
				);
		}
	}
	return out;
}
