import type { ExtractorType } from "@lingui/conf";
import { parse } from "smol-toml";
import { templateTexts } from "../../src/features/templates/template-texts.ts";

/** Shipped templates only (`templates/<id>/template.toml`), not test fixtures. */
const TEMPLATE_FILE = /(^|[\\/])templates[\\/]([a-z0-9-]+)[\\/]template\.toml$/;

/**
 * Lingui extractor for template.toml: every translatable field (see
 * `templateTexts`) becomes a message whose id is the English text, with a
 * translator comment naming the template and field. Registered in
 * lingui.config.ts next to the default (babel) extractor.
 */
export const templateExtractor: ExtractorType = {
	match(filename) {
		return TEMPLATE_FILE.test(filename) && !filename.includes("__fixtures__");
	},
	extract(filename, code, onMessageExtracted) {
		const id = filename.match(TEMPLATE_FILE)?.[2] ?? "?";
		const lines = code.split("\n");
		for (const { text, field } of templateTexts(parse(code))) {
			// Line of the text in the file, for the catalog origin.
			const quoted = JSON.stringify(text).slice(1, -1);
			const index = lines.findIndex(
				(line) => line.includes(text) || line.includes(quoted),
			);
			onMessageExtracted({
				id: text,
				comment: `template ${id}: ${field}`,
				origin: [filename, index + 1],
			});
		}
	},
};
