import { z } from "zod";
import manifestJson from "../locales/locales.json";

/**
 * The single list of UI languages: `src/locales/locales.json`. Read by
 * `lingui.config.ts` (extract/compile), `src/libs/i18n.ts` (routing, cookie,
 * language menu) and the server catalogs (`src/server/services/i18n.ts`).
 * Adding a language = one entry there + `src/locales/<code>.json` (and
 * optionally `src/locales/<code>.glossary.json`); no code change.
 *
 * Kept free of app imports so the Lingui CLI config can load it.
 */
const LocaleEntrySchema = z.object({
	/** BCP 47 tag; also the catalog file name and the URL prefix. */
	code: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
	/** The language message ids are written in (exactly one entry). */
	source: z.boolean().optional(),
	/** Text direction, when the language is written right to left. */
	dir: z.enum(["ltr", "rtl"]).optional(),
});

export const LocaleManifestSchema = z
	.array(LocaleEntrySchema)
	.min(1)
	.refine(
		(entries) =>
			new Set(entries.map((entry) => entry.code)).size === entries.length,
		"duplicate locale code",
	)
	.refine(
		(entries) => entries.filter((entry) => entry.source).length === 1,
		"exactly one locale must be the source",
	);

export type LocaleEntry = z.infer<typeof LocaleEntrySchema>;

/** Validated manifest entries plus the derived source locale and codes. */
export function parseLocaleManifest(data: unknown) {
	const entries = LocaleManifestSchema.parse(data);
	const source = entries.find((entry) => entry.source) as LocaleEntry;
	return {
		entries,
		codes: entries.map((entry) => entry.code),
		sourceLocale: source.code,
	};
}

export const localeManifest = parseLocaleManifest(manifestJson);
export const localeCodes = localeManifest.codes;
export const sourceLocale = localeManifest.sourceLocale;
