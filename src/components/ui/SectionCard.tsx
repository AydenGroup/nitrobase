import { Card, Group, Stack, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";

/** Card with a header (title, description, actions) and body. */
export const SectionCard: React.FC<{
	title?: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	/** No body padding (tables). */
	flush?: boolean;
	tone?: "default" | "danger";
}> = ({
	title,
	description,
	actions,
	children,
	flush = false,
	tone = "default",
}) => (
	<Card
		p={0}
		data-tone={tone}
		style={
			tone === "danger"
				? { borderColor: "var(--mantine-color-red-7)" }
				: undefined
		}
	>
		{(title || actions) && (
			<Group
				justify="space-between"
				align="flex-start"
				p="md"
				pb={flush ? "md" : 0}
				gap="sm"
			>
				<Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
					{title && (
						<Title order={5} c={tone === "danger" ? "red.6" : undefined}>
							{title}
						</Title>
					)}
					{description && (
						<Text size="sm" c="dimmed">
							{description}
						</Text>
					)}
				</Stack>
				{actions && <Group gap="xs">{actions}</Group>}
			</Group>
		)}
		<div style={flush ? undefined : { padding: "var(--mantine-spacing-md)" }}>
			{children}
		</div>
	</Card>
);
