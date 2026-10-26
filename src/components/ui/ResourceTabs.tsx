import { useLingui } from "@lingui/react";
import {
	Box,
	type ComboboxItem,
	type ComboboxItemGroup,
	Divider,
	Flex,
	Group,
	Select,
	Tabs,
	Text,
} from "@mantine/core";
import type { LucideIcon } from "lucide-react";
import { Fragment, type ReactNode, useEffect } from "react";
import { resourceTabsLayout } from "#/theme/tokens.ts";

/** One tab of a detail page (labels already translated). */
export interface ResourceTabItem {
	id: string;
	label: string;
	icon?: LucideIcon;
	/**
	 * Section the tab belongs to (e.g. a provider plugin's name). A change of
	 * section between consecutive tabs draws a divider; a section with a
	 * label shows it as a heading.
	 */
	section?: { id: string; label?: string };
}

const { breakpoint, listWidth, iconSize } = resourceTabsLayout;

/**
 * The tab to show for a requested one (`?tab=`): itself when it is among
 * the visible tabs (permission- and plugin-filtered), else `fallback`
 * (overview), else the first tab.
 */
export function resolveTab(
	requested: string,
	items: Pick<ResourceTabItem, "id">[],
	fallback = "overview",
): string {
	const ids = new Set(items.map((item) => item.id));
	if (ids.has(requested)) return requested;
	if (ids.has(fallback) || !items.length) return fallback;
	return items[0].id;
}

/** Consecutive items with the same section id, in order. */
export function groupTabItems(
	items: ResourceTabItem[],
): { id: string; label?: string; items: ResourceTabItem[] }[] {
	const groups: { id: string; label?: string; items: ResourceTabItem[] }[] = [];
	for (const item of items) {
		const id = item.section?.id ?? "";
		const last = groups.at(-1);
		if (last && last.id === id) last.items.push(item);
		else groups.push({ id, label: item.section?.label, items: [item] });
	}
	return groups;
}

/**
 * Tabs of a resource detail page (app, database, server). From the
 * `resourceTabsLayout` breakpoint up: a vertical tab column (sticky under
 * the header) beside the panel. Below it: a select of the tabs, which never
 * overflows however many tabs plugins add. Children are the `Tabs.Panel`s.
 */
export const ResourceTabs: React.FC<{
	value: string;
	onChange: (value: string) => void;
	items: ResourceTabItem[];
	children: ReactNode;
}> = ({ value: requested, onChange, items, children }) => {
	const { i18n } = useLingui();
	const value = resolveTab(requested, items);
	// A tab that isn't shown (no permission, other template): keep the URL on
	// the tab actually displayed.
	useEffect(() => {
		if (value !== requested) onChange(value);
	}, [value, requested, onChange]);
	const groups = groupTabItems(items);
	const current = items.find((item) => item.id === value);
	const CurrentIcon = current?.icon;
	const selectData = groups.flatMap(
		(group): (ComboboxItem | ComboboxItemGroup<ComboboxItem>)[] => {
			const options = group.items.map((item) => ({
				value: item.id,
				label: item.label,
			}));
			return group.label ? [{ group: group.label, items: options }] : options;
		},
	);
	const icons = new Map(items.map((item) => [item.id, item.icon]));

	return (
		<Tabs
			value={value}
			onChange={(next) => next && onChange(next)}
			orientation="vertical"
			variant="pills"
			keepMounted={false}
			styles={{ root: { display: "block" } }}
		>
			<Flex
				direction={{ base: "column", [breakpoint]: "row" }}
				gap="lg"
				align={{ base: "stretch", [breakpoint]: "flex-start" }}
			>
				<Select
					hiddenFrom={breakpoint}
					aria-label={i18n._("Section")}
					data={selectData}
					value={value}
					onChange={(next) => next && onChange(next)}
					allowDeselect={false}
					searchable={false}
					leftSection={
						CurrentIcon ? <CurrentIcon size={iconSize} /> : undefined
					}
					renderOption={({ option }) => {
						const Icon = icons.get(option.value);
						return (
							<Group gap="xs" wrap="nowrap">
								{Icon && <Icon size={iconSize} />}
								<span>{option.label}</span>
							</Group>
						);
					}}
				/>
				<Box
					visibleFrom={breakpoint}
					w={listWidth}
					pos="sticky"
					top="calc(var(--app-shell-header-offset, 0rem) + var(--app-bar-height, 0px) + var(--mantine-spacing-md))"
					style={{ flexShrink: 0 }}
				>
					<Tabs.List aria-label={i18n._("Sections")}>
						{groups.map((group, index) => (
							<Fragment key={group.items[0].id}>
								{index > 0 && <Divider my="2xs" role="presentation" />}
								{group.label && (
									<Text
										className="nav-group-label"
										px="xs"
										pb="3xs"
										role="presentation"
										truncate
									>
										{group.label}
									</Text>
								)}
								{group.items.map((item) => {
									const Icon = item.icon;
									return (
										<Tabs.Tab
											key={item.id}
											value={item.id}
											leftSection={Icon ? <Icon size={iconSize} /> : undefined}
											styles={{
												tab: { justifyContent: "flex-start" },
												tabLabel: {
													textAlign: "left",
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
												},
											}}
										>
											{item.label}
										</Tabs.Tab>
									);
								})}
							</Fragment>
						))}
					</Tabs.List>
				</Box>
				<Box style={{ flex: 1, minWidth: 0 }}>{children}</Box>
			</Flex>
		</Tabs>
	);
};
