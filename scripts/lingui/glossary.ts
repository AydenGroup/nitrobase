import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Terminology per locale (UX-19): the one word each product concept uses in
 * a translation. The data lives next to the catalogs in
 * `src/locales/<locale>.glossary.json` (optional per locale);
 * `src/libs/glossary.test.ts` fails when a translation in
 * `src/locales/<locale>.json` uses a `forbidden` form outside placeholders,
 * code, paths and hostnames. Adding a locale's glossary = adding its file.
 */
const GlossaryTermSchema = z.object({
	/** English concept (documentation only). */
	concept: z.string().min(1),
	/** The word translators use (documentation for translators). */
	use: z.string().min(1),
	/** Regular expression sources that must not appear in translations. */
	forbidden: z.array(z.string().min(1)).min(1),
	/** RegExp flags for every `forbidden` pattern. */
	flags: z
		.string()
		.regex(/^[dgimsuvy]*$/)
		.default(""),
});

export const GlossaryFileSchema = z.object({
	terms: z.array(GlossaryTermSchema),
});

export interface GlossaryTerm {
	concept: string;
	use: string;
	forbidden: RegExp[];
}

const localesDir = fileURLToPath(new URL("../../src/locales/", import.meta.url));

/** Path of a locale's glossary file (it may not exist). */
export function glossaryPath(locale: string, dir = localesDir): string {
	return `${dir.replace(/\/$/, "")}/${locale}.glossary.json`;
}

/** Validate glossary file content and compile its patterns. */
export function parseGlossary(data: unknown): GlossaryTerm[] {
	return GlossaryFileSchema.parse(data).terms.map((term) => ({
		concept: term.concept,
		use: term.use,
		forbidden: term.forbidden.map((source) => new RegExp(source, term.flags)),
	}));
}

/** Terms of `locale`'s glossary file, or [] when the locale has none. */
export function loadGlossary(locale: string, dir = localesDir): GlossaryTerm[] {
	const file = glossaryPath(locale, dir);
	if (!existsSync(file)) return [];
	return parseGlossary(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * Text a glossary check looks at: ICU `select`/`plural` keys (their case
 * texts are kept), placeholders (`{app}`), inline code (`` `x` ``),
 * `<placeholders>`, `[sections]`, `user@host`, URLs/paths/hostnames and
 * dotted ids are removed first.
 */
export function prose(text: string): string {
	return text
		.replace(
			/\{\s*\w+\s*,\s*(?:select|plural|selectordinal)\s*,((?:[^{}]|\{[^{}]*\})*)\}/g,
			(_, cases: string) =>
				` ${[...cases.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]).join(" ")} `,
		)
		.replace(/\{[^{}]*\}/g, " ")
		.replace(/\[[\w.]+\]/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/\bhttps?:\/\/\S+/g, " ")
		.replace(/<[^<>]*>/g, " ")
		.replace(/\S+@\S+/g, " ")
		.replace(/[\w-]*[./][\w./-]+/g, " ");
}

/** Catalog entries whose translation uses a forbidden form of a term. */
export function glossaryViolations(
	terms: GlossaryTerm[],
	catalog: Record<string, string>,
): { id: string; term: string; text: string }[] {
	const out: { id: string; term: string; text: string }[] = [];
	for (const [id, text] of Object.entries(catalog)) {
		if (!text) continue;
		const plain = prose(text);
		for (const term of terms) {
			if (
				term.forbidden.some((pattern) => {
					pattern.lastIndex = 0;
					return pattern.test(plain);
				})
			) {
				out.push({ id, term: term.concept, text });
			}
		}
	}
	return out;
}
