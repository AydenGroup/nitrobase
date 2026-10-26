import { useLingui } from "@lingui/react";
import { type MantineSize, ThemeIcon } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type React from "react";
import { useState } from "react";
import { type AppSourceDefinition, appSources } from "#/config/app-sources.ts";
import type { TemplateSummary } from "#/features/templates/schema.ts";
import { templatesQueryOptions } from "#/features/templates/templates.query.ts";

export interface IAppVisual {
	icon: AppSourceDefinition["icon"];
	color: AppSourceDefinition["color"];
	/** The template ships a logo (unknown while templates load: try it). */
	hasLogo: boolean;
}

/**
 * Icon of an app from its template: the template's logo, tinted with its
 * `color` (template.toml), else the icon and colour of its source kind
 * (`#/config/app-sources.ts`). An unknown template is a plain template app.
 */
export function getAppVisual(
	template:
		| Pick<TemplateSummary, "sourceKind" | "color" | "hasLogo">
		| undefined,
): IAppVisual {
	const source = appSources[template?.sourceKind ?? "template"];
	return {
		icon: source.icon,
		color: template?.color ?? source.color,
		hasLogo: template?.hasLogo ?? true,
	};
}

interface IAppIconProps {
	templateId: string;
	name?: string;
	size?: MantineSize;
}

/**
 * Visual badge for apps in tables and lists: the template's SVG logo, or
 * the source kind's icon when there is none (or it fails to load).
 */
export const AppIcon: React.FC<IAppIconProps> = ({
	templateId,
	name,
	size = "md",
}) => {
	const { i18n } = useLingui();
	const [hasError, setHasError] = useState(false);
	const { data: templates } = useQuery(templatesQueryOptions);
	const visual = getAppVisual(
		templates?.find((template) => template.id === templateId),
	);
	const FallbackIcon = visual.icon;

	return (
		<ThemeIcon
			variant="light"
			color={visual.color}
			size={size}
			radius="md"
			style={{ flexShrink: 0 }}
		>
			{!hasError && visual.hasLogo && templateId ? (
				<img
					src={`/api/templates/${templateId}/logo`}
					alt={i18n._("{name} logo", { name: name || templateId })}
					onError={() => setHasError(true)}
					style={{
						width: 18,
						height: 18,
						objectFit: "contain",
					}}
				/>
			) : (
				<FallbackIcon size={16} aria-hidden />
			)}
		</ThemeIcon>
	);
};
