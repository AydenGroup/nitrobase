import transliterationData from "#/config/transliteration.json";
import {
	HOSTNAME_PATTERN,
	SLUG_PATTERN,
	TemplateError,
} from "#/libs/naming-rules.ts";

// Client-safe rules (patterns, TemplateError, env names) live in
// `#/libs/naming-rules.ts`; re-exported for server code.
export {
	APP_FOLDER_PATTERN,
	assertUserEnvName,
	ENV_NAME_PATTERN,
	RESERVED_ENV_PATTERN,
	TemplateError,
	templateError,
} from "#/libs/naming-rules.ts";

/** Letter → ASCII for letters without a Unicode decomposition. */
const transliteration: Record<string, string> = transliterationData.letters;

/** `value` as a slug; refused (coded) otherwise. */
export function assertSlug(value: string): string {
	if (!SLUG_PATTERN.test(value)) {
		throw new TemplateError("SLUG_INVALID", { value });
	}
	return value;
}

export function assertHostname(value: string): string {
	const host = value.trim().toLowerCase();
	if (!HOSTNAME_PATTERN.test(host)) {
		throw new TemplateError("DOMAIN_INVALID", { host: value });
	}
	return host;
}

/** App folder (and compose project) name: `<templateId>-<first 8 of appId>`. */
export function appFolderName(templateId: string, appId: string): string {
	const short = appId.replace(/-/g, "").slice(0, 8).toLowerCase();
	return assertSlug(`${assertSlug(templateId)}-${short}`);
}

/**
 * ASCII fold for slugs, any script: lowercase, Unicode NFKD with the marks
 * dropped (accents, tones), then the letters NFKD cannot decompose from the
 * data table `#/config/transliteration.json` (e.g. a stroked d or o). Other
 * characters are left as they are.
 */
function transliterate(text: string): string {
	return Array.from(
		text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, ""),
		(char) => transliteration[char] ?? char,
	).join("");
}

/**
 * DNS label from a display name: "Client ACME — Blog" → "client-acme-blog".
 * Letters are folded to ASCII (`transliterate`); "" when nothing usable is
 * left.
 */
export function hostLabelFromName(name: string): string {
	const label = transliterate(name)
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return SLUG_PATTERN.test(label) ? label : "";
}
