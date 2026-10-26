import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	parseEnvFile,
	parseRenderedEnvFile,
	type RandomSource,
	referencedVariables,
	renderEnvFile,
	resolveVariables,
	signHS256Jwt,
} from "./variables";

// Deterministic bytes: 0,1,2,... so outputs are stable.
function seqRandom(): RandomSource {
	let n = 0;
	return {
		bytes: (size) => Buffer.from(Array.from({ length: size }, () => n++ % 256)),
		uuid: () => "00000000-0000-4000-8000-000000000000",
	};
}

const builtins = { domain: "app.example.org", url: "https://app.example.org" };

describe("resolveVariables", () => {
	it("evaluates generators with the requested sizes", () => {
		const out = resolveVariables(
			{
				P: { value: "${password:20}" },
				B: { value: "${base64:12}" },
				H: { value: "${hex:16}" },
				U: { value: "${uuid}" },
			},
			{ builtins, random: seqRandom() },
		);
		expect(out.P).toMatch(/^[A-Za-z0-9]{20}$/);
		expect(Buffer.from(out.B, "base64")).toHaveLength(12);
		expect(out.H).toMatch(/^[0-9a-f]{32}$/);
		expect(out.U).toBe("00000000-0000-4000-8000-000000000000");
	});

	it("resolves references regardless of declaration order and keeps order", () => {
		const out = resolveVariables(
			{
				URL: { value: "${BASE}/auth/v1" },
				BASE: { value: "${url}" },
				LITERAL: { value: "cost $$5" },
			},
			{ builtins },
		);
		expect(Object.keys(out)).toEqual(["URL", "BASE", "LITERAL"]);
		expect(out.URL).toBe("https://app.example.org/auth/v1");
		expect(out.LITERAL).toBe("cost $5");
	});

	it("signs Supabase-style JWTs with another variable", () => {
		const out = resolveVariables(
			{
				JWT_SECRET: { value: "super-secret-jwt-key-with-32-chars!!" },
				ANON_KEY: { value: "${jwt:JWT_SECRET:anon:supabase}" },
				PLAIN: { value: "${jwt:JWT_SECRET:anon}" },
			},
			{ builtins, now: 1_700_000_000 },
		);
		const plain = JSON.parse(
			Buffer.from(out.PLAIN.split(".")[1], "base64url").toString(),
		);
		expect(plain.iss).toBeUndefined();
		expect(() =>
			resolveVariables(
				{ S: { value: "x" }, K: { value: "${jwt:S:anon:bad issuer}" } },
				{ builtins },
			),
		).toThrow();
		const [header, payload, signature] = out.ANON_KEY.split(".");
		expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
			alg: "HS256",
			typ: "JWT",
		});
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
		expect(claims).toMatchObject({
			role: "anon",
			iss: "supabase",
			iat: 1_700_000_000,
		});
		expect(claims.exp).toBeGreaterThan(claims.iat);
		expect(signature).toBe(
			createHmac("sha256", "super-secret-jwt-key-with-32-chars!!")
				.update(`${header}.${payload}`)
				.digest("base64url"),
		);
	});

	it("prefers overrides, then existing values, over generation", () => {
		const out = resolveVariables(
			{
				A: { value: "${password:8}" },
				B: { value: "${password:8}" },
				C: { value: "${A}-${B}" },
			},
			{ builtins, overrides: { A: "mine" }, existing: { B: "kept" } },
		);
		expect(out).toEqual({ A: "mine", B: "kept", C: "mine-kept" });
	});

	it("detects cycles, unknown references and bad expressions", () => {
		expect(() =>
			resolveVariables(
				{ A: { value: "${B}" }, B: { value: "${C}" }, C: { value: "${A}" } },
				{ builtins },
			),
		).toThrow(/cycle: A -> B -> C -> A/);
		expect(() =>
			resolveVariables({ A: { value: "${NOPE}" } }, { builtins }),
		).toThrow(/unknown variable NOPE/);
		expect(() =>
			resolveVariables({ A: { value: "${password:0}" } }, { builtins }),
		).toThrow(/Invalid size/);
		expect(() =>
			resolveVariables({ A: { value: "${shell:rm}" } }, { builtins }),
		).toThrow(/Unknown expression/);
		expect(() =>
			resolveVariables({ A: { value: "${domain" } }, { builtins }),
		).toThrow(/is not closed/);
		expect(() =>
			resolveVariables({ "bad-name": { value: "x" } }, { builtins }),
		).toThrow(/Invalid variable name/);
	});

	it("lists references for dependency ordering", () => {
		expect(
			referencedVariables("${A}/${jwt:SECRET:anon}/${domain}/${hex:4}"),
		).toEqual(["A", "SECRET"]);
	});
});

describe("signHS256Jwt", () => {
	it("produces three base64url segments", () => {
		expect(signHS256Jwt("k", { a: 1 }).split(".")).toHaveLength(3);
	});
});

describe("renderEnvFile / parseEnvFile", () => {
	it("quotes every value and round-trips special characters", () => {
		const values = {
			PLAIN: "abc",
			DOLLAR: "a$b${C}",
			QUOTE: 'it\'s "quoted"',
			MULTI: "line1\nline2",
			EMPTY: "",
		};
		const file = renderEnvFile(values);
		expect(file).toContain("PLAIN='abc'");
		expect(file).toContain("DOLLAR='a$b${C}'");
		expect(file).toContain('QUOTE="it\'s \\"quoted\\""');
		expect(file).toContain('MULTI="line1\\nline2"');
		expect(parseEnvFile(file)).toEqual(values);
	});

	it("rejects invalid names", () => {
		expect(() => renderEnvFile({ "A;rm": "x" })).toThrow();
	});

	it("parses upstream .env.example files", () => {
		expect(
			parseEnvFile(
				'# c\nA=1\nexport B="two words"\nC=x # comment\n\nbad line\n',
			),
		).toEqual({ A: "1", B: "two words", C: "x" });
	});
});

describe("parseRenderedEnvFile", () => {
	it("is the exact inverse of renderEnvFile", () => {
		const values = {
			PLAIN: "abc",
			HASH: "a # not a comment",
			DOLLAR: "a$b${C}",
			QUOTE: 'it\'s "quoted"',
			BACKSLASH_N: "it's a\\nb",
			ESCAPES: "it's \\ \\\\ $$ \\$x",
			MULTI: "line1\r\nline2\n",
			SPACES: "  padded  ",
			EMPTY: "",
			JSON: '{"keys":[{"k":"v=="}]}',
		};
		expect(parseRenderedEnvFile(renderEnvFile(values))).toEqual(values);
	});

	it("round-trips random values", () => {
		const alphabet = "ab'\"\\$\n\r #={}=`";
		for (let run = 0; run < 200; run++) {
			let value = "";
			for (let i = 0; i < 12; i++) {
				value += alphabet[Math.floor(Math.random() * alphabet.length)];
			}
			const values = { V: value, W: "x" };
			expect(parseRenderedEnvFile(renderEnvFile(values))).toEqual(values);
		}
	});

	it("skips lines it did not write", () => {
		expect(parseRenderedEnvFile("# c\nA=raw\nB='ok'\n bad\n")).toEqual({
			B: "ok",
		});
	});
});

describe("bcrypt expressions", () => {
	it("hashes another variable and counts as a dependency", async () => {
		const bcrypt = (await import("bcryptjs")).default;
		const { resolveVariables, referencedVariables } = await import(
			"./variables"
		);
		const values = resolveVariables(
			{ PW: { value: "s3cret-pass" }, HASH: { value: "${bcrypt:PW:4}" } },
			{ builtins: {} },
		);
		expect(values.HASH).toMatch(/^\$2b\$04\$/);
		expect(bcrypt.compareSync("s3cret-pass", values.HASH)).toBe(true);
		expect(referencedVariables("${bcrypt:PW}")).toEqual(["PW"]);
		expect(() =>
			resolveVariables(
				{ PW: { value: "x" }, HASH: { value: "${bcrypt:PW:99}" } },
				{ builtins: {} },
			),
		).toThrow(/cost/);
	});
});
