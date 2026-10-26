import { useLingui } from "@lingui/react";
import { Badge, Box, Button, Drawer, Group, Stack } from "@mantine/core";
import { SlidersHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * Filters inline from `sm` up; on phones a single "Filters" button opens
 * them in a bottom drawer (stacked, full width). `children(stacked)`
 * renders the controls for either layout.
 */
export const FilterBar: React.FC<{
	children: (stacked: boolean) => ReactNode;
	/** Filters currently set (shown on the phone button). */
	activeCount: number;
	onClear?: () => void;
}> = ({ children, activeCount, onClear }) => {
	const { i18n } = useLingui();
	const [opened, setOpened] = useState(false);
	return (
		<>
			<Group gap="sm" wrap="wrap" visibleFrom="sm">
				{children(false)}
			</Group>
			<Box hiddenFrom="sm">
				<Button
					variant="default"
					leftSection={<SlidersHorizontal size={16} />}
					rightSection={
						activeCount > 0 ? (
							<Badge size="sm" circle>
								{activeCount}
							</Badge>
						) : undefined
					}
					onClick={() => setOpened(true)}
				>
					{i18n._("Filters")}
				</Button>
			</Box>
			<Drawer
				opened={opened}
				onClose={() => setOpened(false)}
				position="bottom"
				size="auto"
				title={i18n._("Filters")}
				hiddenFrom="sm"
			>
				<Stack gap="sm" pb="md">
					{children(true)}
					<Group grow>
						{onClear && (
							<Button
								variant="default"
								disabled={activeCount === 0}
								onClick={onClear}
							>
								{i18n._("Clear filters")}
							</Button>
						)}
						<Button onClick={() => setOpened(false)}>{i18n._("Done")}</Button>
					</Group>
				</Stack>
			</Drawer>
		</>
	);
};
