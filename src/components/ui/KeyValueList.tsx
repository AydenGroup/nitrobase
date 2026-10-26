import { SimpleGrid, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

export interface KeyValueItem {
	label: ReactNode;
	value: ReactNode;
	key?: string;
}

/** Label/value pairs; two columns on wide screens. */
export const KeyValueList: React.FC<{
	items: KeyValueItem[];
	cols?: number;
}> = ({ items, cols = 2 }) => (
	<SimpleGrid cols={{ base: 1, sm: cols }} spacing="md" verticalSpacing="sm">
		{items.map((item, index) => (
			<Stack key={item.key ?? index} gap={2} style={{ minWidth: 0 }}>
				<Text size="xs" c="dimmed" fw={500} tt="uppercase">
					{item.label}
				</Text>
				<Text size="sm" component="div" style={{ wordBreak: "break-word" }}>
					{item.value ?? "—"}
				</Text>
			</Stack>
		))}
	</SimpleGrid>
);
