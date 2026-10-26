import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	GlossaryFileSchema,
	glossaryPath,
	glossaryViolations,
	loadGlossary,
	parseGlossary,
	prose,
} from "../../scripts/lingui/glossary.ts";
import { localeCodes, sourceLocale } from "./locale-manifest.ts";

/** Locales whose catalogs are translations (everything but the source). */
const translatedLocales = localeCodes.filter((code) => code !== sourceLocale);

const localesDir = fileURLToPath(new URL("../locales/", import.meta.url));

function readCatalog(code: string): Record<string, string> {
	return JSON.parse(readFileSync(`${localesDir}${code}.json`, "utf8"));
}

describe("translation glossary", () => {
	it("keeps placeholders, code, hosts and user@host out of the check", () => {
		expect(
			prose("Open {app} at app.example.com or `app` <domain> user@server"),
		).not.toMatch(/app|domain|server/);
	});

	it("keeps ICU case texts but not their keys", () => {
		expect(
			prose("{n, select, deploying {being deployed} other {idle}} [backup]"),
		).not.toMatch(/deploying|backup|\{/);
		expect(prose("{n, select, a {an app} other {apps}}")).toMatch(/an app/);
	});

	it("compiles patterns from data and reports forbidden forms", () => {
		const terms = parseGlossary({
			terms: [
				{ concept: "app", use: "x", forbidden: ["\\bapps?\\b"], flags: "i" },
			],
		});
		expect(
			glossaryViolations(terms, {
				a: "Open the APP",
				b: "Open {app}",
				c: "",
			}).map((item) => item.id),
		).toEqual(["a"]);
	});

	it("glossary files belong to locales of the manifest", () => {
		const files = readdirSync(localesDir).filter((file) =>
			file.endsWith(".glossary.json"),
		);
		for (const file of files) {
			expect(localeCodes).toContain(file.replace(/\.glossary\.json$/, ""));
		}
	});

	describe.each(translatedLocales)("%s catalog", (code) => {
		it("exists and has no untranslated message", () => {
			const missing = Object.entries(readCatalog(code))
				.filter(([, text]) => !text)
				.map(([id]) => id);
			expect(missing).toEqual([]);
		});

		it("uses one word per concept (its glossary file, if any)", () => {
			const file = glossaryPath(code);
			if (existsSync(file)) {
				expect(() =>
					GlossaryFileSchema.parse(JSON.parse(readFileSync(file, "utf8"))),
				).not.toThrow();
			}
			expect(glossaryViolations(loadGlossary(code), readCatalog(code))).toEqual(
				[],
			);
		});
	});
});
