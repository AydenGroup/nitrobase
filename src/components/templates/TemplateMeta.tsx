import { useLingui } from "@lingui/react";
import { ActionIcon, Alert, Badge, Group, Text, Tooltip } from "@mantine/core";
import { BookOpen, ExternalLink, ShieldAlert } from "lucide-react";
import { localizedTemplate } from "#/components/templates/localized.ts";
import { lookup } from "#/config/labels.ts";
import { APP_NAME } from "#/config/shared.ts";
import { templateCategories } from "#/config/template-categories.ts";
import type { TemplateSummary } from "#/features/templates/schema.ts";
import { formatList } from "#/libs/intl.ts";

/** Category label (registry), falling back to the raw id. */
export function useCategoryLabel() {
	const { i18n } = useLingui();
	return (category: string) => {
		const label = lookup(templateCategories, category);
		return label ? i18n._(label) : category;
	};
}

/** Category, advanced and elevated-permission badges of a template. */
export const TemplateBadges: React.FC<{ template: TemplateSummary }> = ({
	template,
}) => {
	const { i18n } = useLingui();
	const categoryLabel = useCategoryLabel();
	const { securityReason } = localizedTemplate(template, i18n);
	return (
		<Group gap={4} wrap="wrap">
			<Badge variant="light" size="sm">
				{categoryLabel(template.category)}
			</Badge>
			{template.advanced && (
				<Badge variant="light" color="orange" size="sm">
					{i18n._("Advanced")}
				</Badge>
			)}
			{template.security.allows.length > 0 && (
				<Tooltip
					label={
						securityReason ??
						formatList(i18n.locale, template.security.allows, "unit")
					}
					multiline
					w={280}
				>
					<Badge
						variant="light"
						color="red"
						size="sm"
						leftSection={<ShieldAlert size={12} />}
					>
						{i18n._("Elevated access")}
					</Badge>
				</Tooltip>
			)}
		</Group>
	);
};

/** Website and documentation links (open in a new tab). */
export const TemplateLinks: React.FC<{ template: TemplateSummary }> = ({
	template,
}) => {
	const { i18n } = useLingui();
	return (
		<Group gap={2}>
			{template.website && (
				<Tooltip label={i18n._("Website")}>
					<ActionIcon
						component="a"
						href={template.website}
						target="_blank"
						rel="noopener noreferrer"
						variant="subtle"
						color="gray"
						aria-label={i18n._("Website")}
					>
						<ExternalLink size={16} />
					</ActionIcon>
				</Tooltip>
			)}
			{template.docs && (
				<Tooltip label={i18n._("Documentation")}>
					<ActionIcon
						component="a"
						href={template.docs}
						target="_blank"
						rel="noopener noreferrer"
						variant="subtle"
						color="gray"
						aria-label={i18n._("Documentation")}
					>
						<BookOpen size={16} />
					</ActionIcon>
				</Tooltip>
			)}
		</Group>
	);
};

/**
 * What the owner must know before deploying: elevated permissions the
 * template's `[security]` allows (with its reason) and the advanced flag.
 */
export const TemplateWarnings: React.FC<{ template: TemplateSummary }> = ({
	template,
}) => {
	const { i18n } = useLingui();
	const { securityReason } = localizedTemplate(template, i18n);
	return (
		<>
			{template.security.allows.length > 0 && (
				<Alert
					color="red"
					variant="light"
					icon={<ShieldAlert size={18} />}
					title={i18n._("This template needs elevated access")}
				>
					{securityReason}
					<br />
					{i18n._("Allowed beyond the default policy: {items}", {
						items: formatList(i18n.locale, template.security.allows, "unit"),
					})}
				</Alert>
			)}
			{template.advanced && (
				<Alert color="orange" variant="light" title={i18n._("Advanced")}>
					{i18n._(
						"You provide the compose file: {appName} checks it against the same safety rules as every template, but cannot know whether it works or keeps your data safe.",
						{ appName: APP_NAME },
					)}
				</Alert>
			)}
		</>
	);
};

/** The template's limitation label (metadata), if any. */
export const TemplateLimitation: React.FC<{ template: TemplateSummary }> = ({
	template,
}) => {
	const { i18n } = useLingui();
	const { limitation } = localizedTemplate(template, i18n);
	if (!limitation) return null;
	return (
		<Text size="xs" c="orange" mt={4}>
			{limitation}
		</Text>
	);
};
