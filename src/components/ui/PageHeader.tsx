import { Group, Stack, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";

/** Page title row: title (+ badge), description, right-aligned actions. */
export const PageHeader: React.FC<{
	title: ReactNode;
	description?: ReactNode;
	badge?: ReactNode;
	actions?: ReactNode;
}> = ({ title, description, badge, actions }) => (
	<Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
		<Stack gap={4} style={{ minWidth: 0, flex: "1 1 280px" }}>
			<Group gap="sm" wrap="nowrap">
				<Title
					order={2}
					fz={{ base: "xl", sm: "2xl" }}
					style={{ wordBreak: "break-word" }}
				>
					{title}
				</Title>
				{badge}
			</Group>
			{description && (
				<Text c="dimmed" size="sm" component="div">
					{description}
				</Text>
			)}
		</Stack>
		{actions && (
			<Group gap="xs" wrap="wrap">
				{actions}
			</Group>
		)}
	</Group>
);
