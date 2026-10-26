import { describe, expect, it, vi } from "vitest";
import type { ErrorInfo } from "#/libs/coded.ts";
import type { FetchedFile } from "./github";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { applyRewrites } = await import("./render");
const { matchFailureSignature } = await import(
	"#/config/failure-signatures.ts"
);

const file = (path: string, text: string): FetchedFile => ({
	path,
	content: Buffer.from(text),
	executable: false,
});

const rewrites = [
	{ path: "main.ts", find: "'jsr:", replace: "'${MIRROR}/", when: "MIRROR" },
	{ path: "main.ts", find: '"jsr:', replace: '"${MIRROR}/', when: "MIRROR" },
];

describe("template rewrites", () => {
	it("does nothing while the variable is empty", () => {
		const files = [file("main.ts", "import x from 'jsr:@a/b@1'")];
		const before = files[0];
		const warnings: ErrorInfo[] = [];
		applyRewrites(files, rewrites, { MIRROR: "" }, warnings);
		expect(files[0]).toBe(before);
		expect(warnings).toEqual([]);
	});

	it("replaces every match without mutating the fetched file", () => {
		const original = file(
			"main.ts",
			"import x from 'jsr:@a/b@1'\nimport y from 'jsr:@c/d@2'",
		);
		const files = [original];
		const warnings: ErrorInfo[] = [];
		applyRewrites(files, rewrites, { MIRROR: "https://m.test/jsr" }, warnings);
		expect(files[0].content.toString()).toBe(
			"import x from 'https://m.test/jsr/@a/b@1'\nimport y from 'https://m.test/jsr/@c/d@2'",
		);
		expect(original.content.toString()).toContain("'jsr:@a/b@1'");
		// The other quote style did not match: no warning, one alternative did.
		expect(warnings).toEqual([]);
	});

	it("warns when no alternative matches (upstream changed)", () => {
		const files = [file("main.ts", "import x from 'npm:jose'")];
		const warnings: ErrorInfo[] = [];
		applyRewrites(files, rewrites, { MIRROR: "https://m.test" }, warnings);
		expect(warnings.map((warning) => warning.code)).toEqual([
			"TEMPLATE_WARN_REWRITE_UNMATCHED",
		]);
	});

	it("refuses values that could escape a string literal", () => {
		for (const value of [
			"https://m.test/'",
			'a"b',
			"a\\b",
			"a b",
			"a`b",
			"$x",
		]) {
			expect(() =>
				applyRewrites(
					[file("main.ts", "'jsr:x'")],
					rewrites,
					{ MIRROR: value },
					[],
				),
			).toThrow();
		}
	});
});

describe("failure signatures", () => {
	const log =
		"worker boot error: Uncaught (in promise) Error: JSR package manifest for '@panva/jose' failed to load. Import 'https://jsr.io/@panva/jose/meta.json' failed: 403 Forbidden";

	it("turns a JSR download failure into a hint naming the template's variable", () => {
		expect(
			matchFailureSignature(log, "functions", {
				jsr_unreachable: { variable: "FUNCTIONS_JSR_MIRROR" },
			}),
		).toEqual({
			code: "SERVICE_JSR_UNREACHABLE_MIRROR",
			params: {
				service: "functions",
				package: "@panva/jose",
				variable: "FUNCTIONS_JSR_MIRROR",
			},
			text: null,
		});
		expect(matchFailureSignature(log, "functions")?.code).toBe(
			"SERVICE_JSR_UNREACHABLE",
		);
		expect(matchFailureSignature("all good", "functions")).toBeNull();
	});
});
