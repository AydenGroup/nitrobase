import { describe, expect, it } from "vitest";
import { defaultLocale, locales, localizedHref } from "#/libs/i18n.ts";

const other = locales.find((locale) => locale.code !== defaultLocale)?.code;

describe("localizedHref", () => {
	it("leaves the path alone for the default locale", () => {
		expect(localizedHref("/invite/abc", defaultLocale)).toBe("/invite/abc");
	});

	it("prefixes the path with another supported locale", () => {
		expect(other).toBeDefined();
		expect(localizedHref("/invite/abc", other as string)).toBe(
			`/${other}/invite/abc`,
		);
	});

	it("ignores a locale that is not supported", () => {
		expect(localizedHref("/invite/abc", "zz")).toBe("/invite/abc");
	});

	it("is a real path, never a route pattern", () => {
		for (const { code } of locales) {
			expect(localizedHref("/invite/abc", code)).not.toMatch(/[{}$]/);
		}
	});
});
