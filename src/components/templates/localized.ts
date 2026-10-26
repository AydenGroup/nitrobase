import type { I18n } from "@lingui/core";
import type {
	TemplateInput,
	TemplateSummary,
} from "#/features/templates/schema.ts";
import { translateTemplateText } from "#/libs/i18n.ts";

/** A deploy-form variable's texts in the active locale (English fallback). */
export function localizedInput(
	input: Pick<TemplateInput, "name" | "label" | "description" | "group">,
	i18n: I18n,
): { label: string; description?: string; group?: string } {
	return {
		label: input.label ? translateTemplateText(i18n, input.label) : input.name,
		description: translateTemplateText(i18n, input.description),
		group: translateTemplateText(i18n, input.group),
	};
}

/** A template's marketplace/wizard texts in the active locale. */
export function localizedTemplate(
	template: Pick<
		TemplateSummary,
		"name" | "description" | "security" | "notes" | "limitation"
	>,
	i18n: I18n,
): {
	name: string;
	description: string;
	notes: string | null;
	limitation: string | null;
	securityReason: string | null;
} {
	return {
		name: translateTemplateText(i18n, template.name),
		description: translateTemplateText(i18n, template.description) ?? "",
		notes: translateTemplateText(i18n, template.notes) ?? null,
		limitation: translateTemplateText(i18n, template.limitation) ?? null,
		securityReason:
			translateTemplateText(i18n, template.security.reason) ?? null,
	};
}
