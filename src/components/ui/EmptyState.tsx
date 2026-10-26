import { Button, Card, Center, Stack, Text, ThemeIcon } from "@mantine/core";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
	icon: LucideIcon;
	title: string;
	description: string;
	actionLabel?: string;
	action?: () => void;
	/** Custom action node (e.g. a link button). */
	children?: ReactNode;
	compact?: boolean;
	/** Optional wrapper card styling with default background and border. */
	withCard?: boolean;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
	icon: Icon,
	title,
	description,
	actionLabel,
	action,
	children,
	compact = false,
	withCard = false,
}) => {
	const content = (
		<Center mih={compact ? 140 : 280} p="md">
			<Stack align="center" gap="xs">
				<ThemeIcon
					variant="light"
					size={compact ? 40 : 56}
					radius="xl"
					color="gray"
				>
					<Icon size={compact ? 20 : 28} strokeWidth={1.5} />
				</ThemeIcon>
				<Text fw={600} size={compact ? "md" : "lg"} ta="center">
					{title}
				</Text>
				<Text c="dimmed" size="sm" ta="center" maw={420}>
					{description}
				</Text>
				{actionLabel && action && (
					<Button onClick={action} mt="xs">
						{actionLabel}
					</Button>
				)}
				{children}
			</Stack>
		</Center>
	);

	if (withCard) {
		return <Card p={0}>{content}</Card>;
	}

	return content;
};
