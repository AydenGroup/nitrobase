import { describe, expect, it } from "vitest";
import {
	applyEnvChanges,
	applyEnvEdit,
	applyEnvReset,
	carryOverValues,
	dependentsOf,
	domainDerivedVariables,
	editServiceEnv,
	frozenInitialValues,
	initialisedNames,
	isGeneratedExpression,
	keepFrozenValues,
	maskedEnvText,
	rotationDrops,
	SECRET_MASK,
} from "./env-state";

const definitions = {
	JWT_SECRET: "${password:40}",
	ANON_KEY: "${jwt:JWT_SECRET:anon}",
	SITE_URL: "${url}",
	API_URL: "${SITE_URL}/auth/v1",
	ADMIN_EMAIL: "admin@${domain}",
};

describe("env state", () => {
	it("knows which expressions are generated", () => {
		expect(isGeneratedExpression("${password:8}")).toBe(true);
		expect(isGeneratedExpression("x-${hex:4}")).toBe(true);
		expect(isGeneratedExpression("${jwt:A:b}")).toBe(true);
		expect(isGeneratedExpression("https://${domain}")).toBe(false);
		expect(isGeneratedExpression("$${password:8}")).toBe(false);
	});

	it("carries over only generated values", () => {
		expect(
			carryOverValues(definitions, {
				JWT_SECRET: "s",
				ANON_KEY: "jwt",
				SITE_URL: "https://old.example.org",
				EXTRA: "x",
			}),
		).toEqual({ JWT_SECRET: "s", ANON_KEY: "jwt" });
	});

	it("generates a value whose previous one was an empty upstream default", () => {
		const keys = {
			JWT_SECRET: "${password:40}",
			SUPABASE_SECRET_KEY: "${opaque_key:sb_secret_:supabase-self-hosted}",
			JWT_KEYS: "${signing_keys:es256:JWT_SECRET}",
			ANON_KEY_ASYMMETRIC: "${jwt_es256:JWT_KEYS:anon}",
		};
		for (const expression of Object.values(keys)) {
			expect(isGeneratedExpression(expression)).toBe(true);
		}
		expect(isGeneratedExpression("${jwks:JWT_KEYS}")).toBe(false);
		expect(
			carryOverValues(keys, {
				JWT_SECRET: "s",
				SUPABASE_SECRET_KEY: "",
				JWT_KEYS: "",
				ANON_KEY_ASYMMETRIC: "",
			}),
		).toEqual({ JWT_SECRET: "s" });
	});

	it("finds transitive dependents", () => {
		expect([...dependentsOf(definitions, ["SITE_URL"])]).toEqual(["API_URL"]);
		expect([...dependentsOf(definitions, ["JWT_SECRET"])]).toEqual([
			"ANON_KEY",
		]);
	});

	it("masks secrets in .env text", () => {
		expect(maskedEnvText({ A: "1", S: "x", E: "" }, new Set(["S", "E"]))).toBe(
			`A='1'\nS='${SECRET_MASK}'\nE=''\n`,
		);
	});
});

describe("applyEnvEdit", () => {
	const values = {
		JWT_SECRET: "old",
		ANON_KEY: "jwt-old",
		SITE_URL: "https://a.org",
		CUSTOM: "1",
	};
	const base = {
		values,
		overrides: { CUSTOM: "1" },
		templateKeys: new Set(["JWT_SECRET", "ANON_KEY", "SITE_URL"]),
		definitions,
	};

	it("keeps masked values and omitted template keys, removes omitted custom keys", () => {
		const result = applyEnvEdit({
			...base,
			pasted: `JWT_SECRET='${SECRET_MASK}'\nNEW='hello'\n`,
		});
		expect(result.values).toEqual({
			...values,
			CUSTOM: undefined,
			NEW: "hello",
		} as never);
		expect(result.values.CUSTOM).toBeUndefined();
		expect(result.changed).toEqual(["NEW"]);
		expect(result.removed).toEqual(["CUSTOM"]);
		expect(result.overrides).toEqual({ NEW: "hello" });
		expect(result.kept).toEqual(["ANON_KEY", "SITE_URL"]);
	});

	it("drops dependents of changed values so they regenerate", () => {
		const result = applyEnvEdit({
			...base,
			pasted:
				"JWT_SECRET='new-secret'\nANON_KEY='********'\nSITE_URL='https://a.org'\nCUSTOM='1'\n",
		});
		expect(result.changed).toEqual(["JWT_SECRET"]);
		expect(result.values.JWT_SECRET).toBe("new-secret");
		expect(result.values.ANON_KEY).toBeUndefined();
		expect(result.overrides).toEqual({ CUSTOM: "1", JWT_SECRET: "new-secret" });
	});

	it("keeps an explicitly edited dependent", () => {
		const result = applyEnvEdit({
			...base,
			pasted: "JWT_SECRET='new'\nANON_KEY='mine'\nCUSTOM='1'\n",
		});
		expect(result.values.ANON_KEY).toBe("mine");
	});

	it("rejects names compose reads itself", () => {
		expect(() =>
			applyEnvEdit({ ...base, pasted: "COMPOSE_PROFILES=x\n" }),
		).toThrow(/reserved/);
		expect(() =>
			applyEnvEdit({ ...base, pasted: "DOCKER_HOST=tcp://x\n" }),
		).toThrow(/reserved/);
	});

	it("rejects invalid names and lines", () => {
		expect(() => applyEnvEdit({ ...base, pasted: "bad-name=1\n" })).toThrow(
			/Line 1/,
		);
		expect(() =>
			applyEnvEdit({ ...base, pasted: "A=1\nthis is not valid\n" }),
		).toThrow(/Line 2/);
		expect(() => applyEnvEdit({ ...base, pasted: "1BAD=x\n" })).toThrow(
			/Line 1/,
		);
		expect(() => applyEnvEdit({ ...base, pasted: "lower=1\n" })).toThrow(
			/Invalid variable name/,
		);
	});
});

describe("editServiceEnv", () => {
	const options = { reserved: new Set(["SUPABASE_URL"]), maxVars: 3 };

	it("sets and removes values", () => {
		expect(
			editServiceEnv(
				{ A: "1", B: "2" },
				{ set: { C: "3", A: "x" }, remove: ["B"] },
				options,
			),
		).toEqual({ A: "x", C: "3" });
	});

	it("rejects invalid, reserved and too many names", () => {
		expect(() =>
			editServiceEnv({}, { set: { "bad-name": "1" }, remove: [] }, options),
		).toThrow();
		expect(() =>
			editServiceEnv({}, { set: { DOCKER_HOST: "x" }, remove: [] }, options),
		).toThrow(/reserved/);
		expect(() =>
			editServiceEnv({}, { set: { SUPABASE_URL: "x" }, remove: [] }, options),
		).toThrow(/set by the template/);
		expect(() =>
			editServiceEnv(
				{ A: "1", B: "2", C: "3" },
				{ set: { D: "4" }, remove: [] },
				options,
			),
		).toThrow(/At most/);
	});
});

describe("domainDerivedVariables", () => {
	it("finds direct and transitive domain users", () => {
		const derived = domainDerivedVariables({
			OWNER_EMAIL: "admin@${domain}",
			URL: "${url}",
			WEBHOOK: "${URL}/hook",
			PASSWORD: "${password:16}",
			PLAIN: "x",
		});
		expect([...derived].sort()).toEqual(["OWNER_EMAIL", "URL", "WEBHOOK"]);
	});
});

describe("applyEnvReset", () => {
	const templateKeys = new Set(Object.keys(definitions));
	const resetDefinitions = {
		...definitions,
		POSTGRES_PASSWORD: "${password:32}",
		ADMIN_HASH: "${bcrypt:ADMIN_PASSWORD}",
		ADMIN_PASSWORD: "admin",
	};
	const resetKeys = new Set(Object.keys(resetDefinitions));

	it("keeps a generated variable's exact value, dropping only its override", () => {
		const result = applyEnvReset(
			{
				overrides: { POSTGRES_PASSWORD: "chosen-by-owner", ANON_KEY: "mine" },
				values: { POSTGRES_PASSWORD: "chosen-by-owner", ANON_KEY: "mine" },
			},
			["POSTGRES_PASSWORD"],
			{ templateKeys: resetKeys, definitions: resetDefinitions },
		);
		expect(result.reset).toEqual(["POSTGRES_PASSWORD"]);
		expect(result.overrides).toEqual({ ANON_KEY: "mine" });
		expect(result.values.POSTGRES_PASSWORD).toBe("chosen-by-owner");
		expect(result.keepStored).toEqual({ POSTGRES_PASSWORD: "chosen-by-owner" });
		expect(result.touched).toEqual([]);
	});

	it("drops a plain variable's value and re-derives dependents without an override", () => {
		const result = applyEnvReset(
			{
				overrides: { ADMIN_PASSWORD: "secret", SITE_URL: "https://x.io" },
				values: {
					ADMIN_PASSWORD: "secret",
					ADMIN_HASH: "$2b$hash",
					SITE_URL: "https://x.io",
					API_URL: "https://x.io/auth/v1",
				},
			},
			["ADMIN_PASSWORD", "SITE_URL"],
			{
				templateKeys: resetKeys,
				definitions: { ...resetDefinitions },
			},
		);
		expect(result.reset).toEqual(["ADMIN_PASSWORD", "SITE_URL"]);
		expect(result.overrides).toEqual({});
		expect(result.values).toEqual({});
		expect(result.touched.sort()).toEqual(["ADMIN_HASH", "API_URL"]);
	});

	it("never touches a dependent's override", () => {
		const result = applyEnvReset(
			{
				overrides: { SITE_URL: "https://x.io", API_URL: "https://api.x.io" },
				values: { SITE_URL: "https://x.io", API_URL: "https://api.x.io" },
			},
			["SITE_URL"],
			{ templateKeys, definitions },
		);
		expect(result.overrides).toEqual({ API_URL: "https://api.x.io" });
		expect(result.values).toEqual({ API_URL: "https://api.x.io" });
		expect(result.touched).toEqual([]);
	});

	it("skips custom variables and template variables without an override", () => {
		const edit = {
			overrides: { EXTRA: "1" },
			values: { SITE_URL: "https://a.example.org", EXTRA: "1" },
		};
		const result = applyEnvReset(edit, ["EXTRA", "SITE_URL"], {
			templateKeys,
			definitions,
		});
		expect(result.reset).toEqual([]);
		expect(result.overrides).toEqual(edit.overrides);
		expect(result.values).toEqual(edit.values);
	});
});

describe("applyEnvChanges", () => {
	const templateKeys = new Set(Object.keys(definitions));
	const base = {
		values: { JWT_SECRET: "s", ANON_KEY: "jwt", SITE_URL: "u", EXTRA: "1" },
		overrides: { EXTRA: "1" },
		templateKeys,
		definitions,
	};

	it("changes only the named variables", () => {
		const result = applyEnvChanges({
			...base,
			set: { SITE_URL: "v", NEW: "n" },
			remove: ["EXTRA"],
		});
		expect(result.changed).toEqual(["SITE_URL", "NEW"]);
		expect(result.removed).toEqual(["EXTRA"]);
		expect(result.overrides).toEqual({ SITE_URL: "v", NEW: "n" });
		expect(result.values.JWT_SECRET).toBe("s");
	});

	it("keeps template variables named in remove", () => {
		const result = applyEnvChanges({
			...base,
			set: {},
			remove: ["JWT_SECRET"],
		});
		expect(result.kept).toEqual(["JWT_SECRET"]);
		expect(result.values.JWT_SECRET).toBe("s");
	});

	it("refuses the mask as a value and invalid names", () => {
		expect(() =>
			applyEnvChanges({ ...base, set: { NEW: SECRET_MASK }, remove: [] }),
		).toThrow();
		expect(() =>
			applyEnvChanges({ ...base, set: { "bad-name": "x" }, remove: [] }),
		).toThrow();
	});
});

describe("initial_only values", () => {
	const variables = {
		ADMIN_EMAIL: { initial_only: true },
		ADMIN_PASSWORD: { initial_only: true },
		SITE_URL: {},
	};

	it("are frozen only once the app was initialised with them", () => {
		expect([...frozenInitialValues(variables, null)]).toEqual([]);
		const initialised = initialisedNames(variables, {
			ADMIN_EMAIL: "a@b.test",
			ADMIN_PASSWORD: "pw",
			SITE_URL: "https://b.test",
		});
		expect(initialised).toEqual(["ADMIN_EMAIL", "ADMIN_PASSWORD"]);
		expect([...frozenInitialValues(variables, initialised)]).toEqual([
			"ADMIN_EMAIL",
			"ADMIN_PASSWORD",
		]);
		// One a template update added later was never applied: not frozen.
		expect([
			...frozenInitialValues(
				{ ...variables, ADMIN_NAME: { initial_only: true } },
				initialised,
			),
		]).toEqual(["ADMIN_EMAIL", "ADMIN_PASSWORD"]);
	});

	it("carry over even when derived from the domain", () => {
		const previous = {
			JWT_SECRET: "s",
			SITE_URL: "https://old.example.org",
			ADMIN_EMAIL: "admin@old.example.org",
		};
		expect(carryOverValues(definitions, previous)).toEqual({
			JWT_SECRET: "s",
		});
		expect(
			carryOverValues(definitions, previous, new Set(["ADMIN_EMAIL"])),
		).toEqual({ JWT_SECRET: "s", ADMIN_EMAIL: "admin@old.example.org" });
	});

	it("refuse edits once frozen", () => {
		const frozen = new Set(["ADMIN_PASSWORD"]);
		const state = { values: { ADMIN_PASSWORD: "old" }, overrides: {} };
		expect(() =>
			keepFrozenValues(frozen, ["ADMIN_PASSWORD"], state, state),
		).toThrow(expect.objectContaining({ code: "ENV_INITIAL_ONLY" }));
		expect(
			keepFrozenValues(new Set(), ["ADMIN_PASSWORD"], state, state),
		).toEqual(state);
	});

	it("keep their value when dropped as a dependent of another edit", () => {
		const frozen = new Set(["ADMIN_EMAIL"]);
		const before = {
			values: { BASE: "a", ADMIN_EMAIL: "admin@a" },
			overrides: { ADMIN_EMAIL: "admin@a" },
		};
		const after = { values: { BASE: "b" }, overrides: { BASE: "b" } };
		expect(keepFrozenValues(frozen, ["BASE"], before, after)).toEqual({
			values: { BASE: "b", ADMIN_EMAIL: "admin@a" },
			overrides: { BASE: "b", ADMIN_EMAIL: "admin@a" },
		});
	});

	it("survive a rotation of a value they derive from", () => {
		const defs = {
			SECRET: "${password:32}",
			TOKEN: "${jwt:SECRET:anon}",
			ADMIN_KEY: "${jwt:SECRET:admin}",
		};
		expect([...rotationDrops(defs, "SECRET", new Set())]).toEqual([
			"SECRET",
			"TOKEN",
			"ADMIN_KEY",
		]);
		expect([...rotationDrops(defs, "SECRET", new Set(["ADMIN_KEY"]))]).toEqual([
			"SECRET",
			"TOKEN",
		]);
	});
});
