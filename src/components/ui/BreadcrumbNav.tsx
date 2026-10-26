import { useLingui } from "@lingui/react";
import { Anchor, Breadcrumbs, Text } from "@mantine/core";
import { isMatch, useMatches } from "@tanstack/react-router";
import { ChevronRight, Home } from "lucide-react";
import { LocalizedLink, stripLocale } from "#/libs/i18n";

/**
 * Header breadcrumbs built from the active route matches: any route whose
 * loader returns `{ crumb: string }` contributes one item (already
 * localized by the loader). The last item is plain text. Match pathnames
 * carry the URL locale (`/vi/servers`), and LocalizedLink adds it again,
 * so it is stripped first.
 */
export const BreadcrumbNav: React.FC = () => {
	const { i18n } = useLingui();
	const matches = useMatches();
	const matchesWithCrumbs = matches.filter((match) =>
		isMatch(match, "loaderData.crumb"),
	);

	const items = matchesWithCrumbs.map(({ pathname, loaderData }) => ({
		href: stripLocale(pathname),
		label: loaderData?.crumb as string,
	}));

	if (items.length === 0) {
		return null;
	}

	return (
		<Breadcrumbs
			aria-label={i18n._("Breadcrumb")}
			separatorMargin={5}
			separator={<ChevronRight size={16} color="var(--mantine-color-dimmed)" />}
		>
			<Anchor
				component={LocalizedLink}
				to="/"
				size="sm"
				underline="never"
				aria-label={i18n._("Home")}
			>
				<Home size={14} aria-hidden />
			</Anchor>
			{items.map((item, index) =>
				index === items.length - 1 ? (
					<Text key={item.href} fz="sm" aria-current="page">
						{item.label}
					</Text>
				) : (
					<Anchor
						underline="never"
						component={LocalizedLink}
						to={item.href}
						size="sm"
						key={item.href}
					>
						{item.label}
					</Anchor>
				),
			)}
		</Breadcrumbs>
	);
};
