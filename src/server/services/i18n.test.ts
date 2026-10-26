import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { localeCodes, sourceLocale } from "#/libs/locale-manifest.ts";
import {
	catalogsFor,
	isLocale,
	localeFromAcceptLanguage,
	localeFromCookieHeader,
	serverI18n,
} from "./i18n";

const localesDir = fileURLToPath(new URL("../../locales/", import.meta.url));
const catalog = (code: string): Record<string, string> =>
	JSON.parse(readFileSync(`${localesDir}${code}.json`, "utf8"));
/** Plain messages (no ICU syntax): rendered text equals the catalog text. */
const plainIds = Object.keys(catalog(sourceLocale)).filter(
	(id) => !/[{}<>']/.test(id),
);
const otherLocale = localeCodes.find((code) => code !== sourceLocale);

describe("server i18n", () => {
	it.each(localeCodes)("serves the compiled %s catalog", (code) => {
		expect(isLocale(code)).toBe(true);
		const i18n = serverI18n(code);
		expect(i18n.locale).toBe(code);
		const texts = catalog(code);
		for (const id of plainIds) {
			expect(i18n._(id)).toBe(texts[id] || id);
		}
	});

	it("keeps only manifest locales that have a compiled catalog", () => {
		const modules = {
			"../../locales/aa.ts": { messages: { x: "a" } },
			"../../locales/bb.ts": { messages: { x: "b" } },
		};
		expect(catalogsFor(["aa", "cc"], modules)).toEqual({ aa: { x: "a" } });
	});

	it("falls back to the default locale", () => {
		expect(serverI18n("xx").locale).toBe(sourceLocale);
		expect(serverI18n("constructor").locale).toBe(sourceLocale);
		expect(localeFromCookieHeader("locale=xx")).toBeUndefined();
	});

	it.runIf(otherLocale)("reads the locale cookie", () => {
		expect(localeFromCookieHeader(`a=b; locale=${otherLocale}`)).toBe(
			otherLocale,
		);
	});

	it("negotiates Accept-Language", () => {
		expect(localeFromAcceptLanguage(null)).toBeUndefined();
		expect(localeFromAcceptLanguage("xx, yy;q=0.5")).toBeUndefined();
		expect(localeFromAcceptLanguage(`xx, ${sourceLocale}-ZZ;q=0.4`)).toBe(
			sourceLocale,
		);
		if (otherLocale) {
			expect(
				localeFromAcceptLanguage(`${sourceLocale};q=0.2, ${otherLocale};q=0.9`),
			).toBe(otherLocale);
		}
	});
});
