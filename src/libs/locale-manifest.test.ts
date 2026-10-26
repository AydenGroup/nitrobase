import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifestJson from "../locales/locales.json";
import { parseLocaleManifest } from "./locale-manifest.ts";

/** A code that is not in the real manifest (the simulated new language). */
const extraCode = ["fr", "de", "es", "ja"].find(
	(code) => !manifestJson.some((entry) => entry.code === code),
) as string;

describe("locale manifest", () => {
	it("needs exactly one source locale and unique codes", () => {
		expect(() => parseLocaleManifest([{ code: "aa" }])).toThrow();
		expect(() =>
			parseLocaleManifest([{ code: "aa", source: true }, { code: "aa" }]),
		).toThrow();
		expect(() =>
			parseLocaleManifest([{ code: "Not a tag!", source: true }]),
		).toThrow();
		expect(parseLocaleManifest(manifestJson).codes.length).toBeGreaterThan(0);
	});
});

/**
 * Adding a language must need no code change: with one more manifest entry
 * (the JSON data only), every consumer picks it up.
 */
describe("adding a language is data only", () => {
	afterEach(() => {
		vi.doUnmock("../locales/locales.json");
		vi.resetModules();
	});

	async function withExtraLocale() {
		vi.resetModules();
		vi.doMock("../locales/locales.json", () => ({
			default: [...manifestJson, { code: extraCode }],
		}));
		return {
			manifest: await import("./locale-manifest.ts"),
			i18n: await import("./i18n.ts"),
			lingui: (await import("../../lingui.config.ts")).default,
			config: await import("#/config/server.ts"),
			server: await import("#/server/services/i18n.ts"),
		};
	}

	it("reaches Lingui, routing, the language menu, settings and server i18n", async () => {
		const { manifest, i18n, lingui, config, server } = await withExtraLocale();
		const source = manifest.sourceLocale;

		// Lingui extract/compile creates and compiles src/locales/<code>.json.
		expect(lingui.locales).toContain(extraCode);
		expect(lingui.sourceLocale).toBe(source);

		// Routing, cookie and the language menu (LocaleButton lists `locales`).
		const entry = i18n.locales.find((item) => item.code === extraCode);
		expect(entry?.nativeName).toBe(
			new Intl.DisplayNames([extraCode], { type: "language" })
				.of(extraCode)
				?.replace(/^./, (first) => first.toLocaleUpperCase(extraCode)),
		);
		expect(entry?.name).toBe(
			new Intl.DisplayNames([source], { type: "language" }).of(extraCode),
		);
		expect(i18n.isValidLocale(extraCode)).toBe(true);
		expect(i18n.localeParams(extraCode)).toEqual({ locale: extraCode });
		expect(i18n.stripLocale(`/${extraCode}/apps`)).toBe("/apps");
		expect(i18n.localeDirection(extraCode)).toBe("ltr");

		// NOTIFY_LOCALE accepts it.
		expect(
			config.loadConfig({ ...process.env, NOTIFY_LOCALE: extraCode })
				.NOTIFY_LOCALE,
		).toBe(extraCode);

		// Server catalogs: picked up by file name once compiled.
		expect(
			server.catalogsFor(manifest.localeCodes, {
				[`../../locales/${extraCode}.ts`]: { messages: { a: "b" } },
			}),
		).toEqual({ [extraCode]: { a: "b" } });
	}, 60_000);

	it("lints its catalog with an optional glossary file", async () => {
		const { loadGlossary, glossaryViolations } = await import(
			"../../scripts/lingui/glossary.ts"
		);
		const dir = mkdtempSync(path.join(tmpdir(), "glossary-"));
		try {
			expect(loadGlossary(extraCode, dir)).toEqual([]);
			writeFileSync(
				path.join(dir, `${extraCode}.glossary.json`),
				JSON.stringify({
					terms: [
						{
							concept: "app",
							use: "x",
							forbidden: ["\\bapps?\\b"],
							flags: "i",
						},
					],
				}),
			);
			const terms = loadGlossary(extraCode, dir);
			expect(
				glossaryViolations(terms, { Apps: "Apps", "Open {app}": "x {app}" }),
			).toEqual([{ id: "Apps", term: "app", text: "Apps" }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
