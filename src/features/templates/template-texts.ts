/**
 * Translatable texts of a template.toml (English source). Shared by the
 * Lingui extractor (`scripts/lingui/template-extractor.ts`, which puts them
 * in the catalogs) and the catalog coverage test. Templates hold English
 * only; translations live in `src/locales/<code>.json` like any other
 * message, and the UI shows them through `translateTemplateText`.
 *
 * Works on the parsed TOML object (no schema), so the extractor stays
 * independent of the runtime validation.
 */
export interface TemplateText {
	/** English text: the message id. */
	text: string;
	/** Where it comes from, e.g. "variable SMTP_HOST label" (translator note). */
	field: string;
}

/** Top-level fields, in display order. */
const TEMPLATE_FIELDS = ["name", "description", "notes", "limitation"] as const;
const VARIABLE_FIELDS = ["label", "description", "group"] as const;
const PORT_FIELDS = ["label", "description"] as const;
const ROTATE_HOOK_FIELDS = ["label", "description", "skipped"] as const;

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function templateTexts(raw: unknown): TemplateText[] {
	if (!isTable(raw)) return [];
	const out: TemplateText[] = [];
	const add = (value: unknown, field: string) => {
		if (typeof value === "string" && value.trim()) {
			out.push({ text: value, field });
		}
	};
	for (const field of TEMPLATE_FIELDS) add(raw[field], field);
	if (isTable(raw.security)) add(raw.security.reason, "security reason");
	if (isTable(raw.variables)) {
		for (const [name, variable] of Object.entries(raw.variables)) {
			if (!isTable(variable)) continue;
			for (const field of VARIABLE_FIELDS) {
				add(variable[field], `variable ${name} ${field}`);
			}
			if (isTable(variable.on_rotate)) {
				for (const field of ROTATE_HOOK_FIELDS) {
					add(variable.on_rotate[field], `variable ${name} on_rotate ${field}`);
				}
			}
		}
	}
	if (Array.isArray(raw.links)) {
		for (const link of raw.links) {
			if (isTable(link)) add(link.label, "link label");
		}
	}
	// Tags are shown as chips on the marketplace (display texts).
	if (Array.isArray(raw.tags)) {
		for (const tag of raw.tags) add(tag, "tag");
	}
	if (Array.isArray(raw.ports)) {
		for (const port of raw.ports) {
			if (!isTable(port)) continue;
			for (const field of PORT_FIELDS) {
				add(port[field], `port ${String(port.id ?? "")} ${field}`.trim());
			}
		}
	}
	return out;
}
