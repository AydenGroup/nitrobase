import { useLingui } from "@lingui/react";
import { NavLink, Stack, Text } from "@mantine/core";
import { useLocation } from "@tanstack/react-router";
import { AppsNavList } from "#/components/apps/AppsNavList";
import { useCan } from "#/components/teams/useCan";
import { isNavItemActive, navSections } from "#/config/navigation.ts";
import { LocalizedLink, stripLocale } from "#/libs/i18n";

export const NavigationMenu: React.FC<{ onNavigate?: () => void }> = ({
	onNavigate,
}) => {
	const { i18n } = useLingui();
	const { pathname } = useLocation();
	const path = stripLocale(pathname);
	const can = useCan();
	const sections = navSections
		.filter((section) => (section.placement ?? "sidebar") === "sidebar")
		.map((section) => ({
			...section,
			items: section.items.filter(
				(item) => !item.permission || can(item.permission),
			),
		}))
		.filter((section) => section.items.length > 0);

	return (
		<Stack gap="sm">
			{sections.map((section) => (
				<Stack key={section.id} gap={2}>
					{section.items.length > 1 || section.showApps ? (
						<Text className="nav-group-label" px="xs" pt="xs" pb="3xs">
							{i18n._(section.label)}
						</Text>
					) : null}
					{section.items.map((item) => {
						const Icon = item.icon;
						return (
							<NavLink
								key={item.to}
								component={LocalizedLink}
								to={item.to}
								// Keep the router's own active marker in sync with ours.
								activeOptions={{ exact: !!item.exact || item.to === "/" }}
								label={i18n._(item.label)}
								active={isNavItemActive(item, path)}
								onClick={onNavigate}
								fw={500}
								py={5}
								leftSection={<Icon size={16} strokeWidth={1.6} />}
								bdrs="md"
							/>
						);
					})}
					{section.showApps && <AppsNavList onNavigate={onNavigate} />}
				</Stack>
			))}
		</Stack>
	);
};
