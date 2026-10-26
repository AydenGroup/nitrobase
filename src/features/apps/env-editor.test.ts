import { describe, expect, it, vi } from "vitest";
import type { AppEnvVariable } from "./schema";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const {
	applyRevealed,
	countEnvChanges,
	diffEnvDraft,
	draftFromText,
	draftToText,
	envNameProblem,
	envSavePayload,
	envSections,
	matchesEnvQuery,
} = await import("./env-editor");

const variable = (
	name: string,
	extra: Partial<AppEnvVariable> = {},
): AppEnvVariable => ({
	name,
	template: true,
	secret: false,
	generated: false,
	rotatable: false,
	rotateHook: null,
	locked: false,
	overridden: false,
	...extra,
});

describe("envSections", () => {
	it("groups template variables by group in template order, then custom ones", () => {
		const variables = [
			variable("SITE_URL"),
			variable("SMTP_HOST", { group: "Email" }),
			variable("ADMIN_EMAIL"),
			variable("S3_BUCKET", { group: "Storage" }),
			variable("SMTP_PORT", { group: "Email" }),
			variable("EXTRA", { template: false }),
		];
		const draft = Object.fromEntries(
			[...variables.map((item) => item.name), "NEW_ONE"].map((name) => [
				name,
				"",
			]),
		);
		expect(envSections(variables, draft)).toEqual([
			{ id: "general", kind: "general", names: ["SITE_URL", "ADMIN_EMAIL"] },
			{
				id: "group:Email",
				kind: "group",
				title: "Email",
				names: ["SMTP_HOST", "SMTP_PORT"],
			},
			{
				id: "group:Storage",
				kind: "group",
				title: "Storage",
				names: ["S3_BUCKET"],
			},
			{ id: "custom", kind: "custom", names: ["EXTRA", "NEW_ONE"] },
		]);
	});

	it("always has the custom section and leaves deleted custom variables out", () => {
		const sections = envSections([variable("EXTRA", { template: false })], {});
		expect(sections).toEqual([{ id: "custom", kind: "custom", names: [] }]);
	});
});

describe("diffEnvDraft", () => {
	const base = { A: "1", B: "2", C: "3", T: "t" };

	it("finds changed, added, removed and reset variables", () => {
		const changes = diffEnvDraft(
			base,
			{ A: "1", B: "two", T: "t", D: "4" },
			new Set(["T"]),
		);
		expect(changes).toEqual({
			changed: ["B"],
			added: ["D"],
			removed: ["C"],
			reset: ["T"],
		});
		expect(countEnvChanges(changes)).toBe(4);
	});

	it("reports no change for an untouched draft", () => {
		expect(countEnvChanges(diffEnvDraft(base, { ...base }, new Set()))).toBe(0);
	});
});

describe("Developer view text", () => {
	const current = { SITE: "x", SECRET: "********", EXTRA: "1" };
	const templateNames = new Set(["SITE", "SECRET"]);

	it("round-trips the draft", () => {
		expect(draftFromText(draftToText(current), current, templateNames)).toEqual(
			current,
		);
	});

	it("keeps template variables missing from the text, drops custom ones", () => {
		expect(
			draftFromText("SITE=y\nNEW='a b'\n", current, templateNames),
		).toEqual({ SITE: "y", SECRET: "********", NEW: "a b" });
	});

	it("rejects invalid lines and names like the server", () => {
		expect(() => draftFromText("not a line", current, templateNames)).toThrow();
		expect(() =>
			draftFromText("DOCKER_HOST=x", current, templateNames),
		).toThrow();
		expect(() => draftFromText("lower=x", current, templateNames)).toThrow();
	});
});

describe("envNameProblem", () => {
	it("checks the name pattern, reserved prefixes and duplicates", () => {
		expect(envNameProblem("MY_VAR", {})).toBeNull();
		expect(envNameProblem("MY_VAR", { MY_VAR: "" })).toBe("duplicate");
		expect(envNameProblem("my-var", {})).toMatchObject({
			code: "VARIABLE_NAME_INVALID",
		});
		expect(envNameProblem("COMPOSE_FILE", {})).toMatchObject({
			code: "VARIABLE_NAME_RESERVED",
		});
	});
});

describe("applyRevealed", () => {
	it("unmasks unchanged values and keeps edits", () => {
		const base = { A: "********", B: "********", C: "c" };
		const result = applyRevealed(
			base,
			{ A: "********", B: "edited", C: "c" },
			{ A: "plain-a", B: "plain-b", C: "c" },
		);
		expect(result.base).toEqual({ A: "plain-a", B: "plain-b", C: "c" });
		expect(result.draft).toEqual({ A: "plain-a", B: "edited", C: "c" });
	});
});

describe("envSavePayload", () => {
	it("sends only changed and added values, never unchanged revealed ones", () => {
		const base = { SECRET: "plain-revealed", SITE: "x", EXTRA: "1", T: "t" };
		const payload = envSavePayload(
			base,
			{ SECRET: "plain-revealed", SITE: "y", T: "t", NEW: "n" },
			new Set(["T"]),
		);
		expect(payload).toEqual({
			set: { SITE: "y", NEW: "n" },
			remove: ["EXTRA"],
			reset: ["T"],
		});
	});

	it("keeps an untouched masked secret out and refuses the mask as a new value", () => {
		expect(
			envSavePayload({ SECRET: "********" }, { SECRET: "********" }, new Set())
				.set,
		).toEqual({});
		expect(() =>
			envSavePayload({}, { NEW: "********" }, new Set()),
		).toThrowError(expect.objectContaining({ code: "ENV_VALUE_MASKED" }));
	});
});

describe("matchesEnvQuery", () => {
	it("matches any text case-insensitively; empty query matches all", () => {
		expect(matchesEnvQuery("smtp", ["SMTP_HOST", undefined])).toBe(true);
		expect(matchesEnvQuery("mail", ["SMTP_HOST", "Email server"])).toBe(true);
		expect(matchesEnvQuery("s3", ["SMTP_HOST"])).toBe(false);
		expect(matchesEnvQuery("  ", ["X"])).toBe(true);
	});
});
