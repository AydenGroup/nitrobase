import { useLingui } from "@lingui/react";
import {
	Box,
	Center,
	Group,
	Loader,
	Stack,
	Table,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

export interface DataColumn<T> {
	key: string;
	header: ReactNode;
	render: (row: T) => ReactNode;
	/** Enables sorting on this column. */
	sortValue?: (row: T) => string | number | Date | null | undefined;
	width?: number | string;
	align?: "left" | "right" | "center";
	/** Hide below the `sm` breakpoint. */
	hideOnMobile?: boolean;
	/**
	 * Phone card layout: "title" is the card heading (default: the first
	 * column), "actions" goes to the card's bottom row (default: columns
	 * without a header). Others are label/value lines.
	 */
	mobile?: "title" | "actions";
}

/** Sortable table with loading/empty states; a card list on phones. */
export function DataTable<T>({
	columns,
	rows,
	getRowKey,
	loading = false,
	empty,
	onRowClick,
	defaultSort,
	minWidth = 640,
	layout,
}: {
	columns: DataColumn<T>[];
	rows: T[];
	getRowKey: (row: T) => string;
	loading?: boolean;
	empty?: ReactNode;
	onRowClick?: (row: T) => void;
	defaultSort?: { key: string; direction: "asc" | "desc" };
	minWidth?: number;
	layout?: React.CSSProperties["tableLayout"];
}) {
	const { i18n } = useLingui();
	const [sort, setSort] = useState(defaultSort ?? null);

	const sorted = useMemo(() => {
		if (!sort) return rows;
		const column = columns.find((item) => item.key === sort.key);
		if (!column?.sortValue) return rows;
		const value = column.sortValue;
		const sign = sort.direction === "asc" ? 1 : -1;
		return [...rows].sort((a, b) => {
			const left = value(a);
			const right = value(b);
			if (left == null) return 1;
			if (right == null) return -1;
			return (left < right ? -1 : left > right ? 1 : 0) * sign;
		});
	}, [rows, columns, sort]);

	const toggle = (key: string) =>
		setSort((current) =>
			current?.key === key
				? { key, direction: current.direction === "asc" ? "desc" : "asc" }
				: { key, direction: "asc" },
		);

	if (loading) {
		return (
			<Center p="xl">
				<Loader size="sm" />
			</Center>
		);
	}
	if (rows.length === 0) {
		return (
			empty ?? (
				<Text c="dimmed" size="sm" p="md">
					{i18n._("Nothing here yet.")}
				</Text>
			)
		);
	}

	// Phones: one card per row (every column visible without sideways
	// scrolling); tables from `sm` up. Both render; CSS picks one.
	const titleColumn =
		columns.find((column) => column.mobile === "title") ?? columns[0];
	const isAction = (column: DataColumn<T>) =>
		column.mobile === "actions" ||
		(column.mobile === undefined &&
			column.header === "" &&
			column !== titleColumn);
	const cards = (
		<Stack gap={0} hiddenFrom="sm">
			{sorted.map((row) => {
				const actions = columns.filter(isAction);
				return (
					<Box
						key={getRowKey(row)}
						px="md"
						py="sm"
						onClick={onRowClick ? () => onRowClick(row) : undefined}
						style={{
							borderTop: "1px solid var(--mantine-color-default-border)",
							cursor: onRowClick ? "pointer" : undefined,
						}}
					>
						<Box fw={600} fz="sm" mb={4} style={{ minWidth: 0 }}>
							{titleColumn.render(row)}
						</Box>
						<Stack gap={4}>
							{columns
								.filter(
									(column) =>
										column !== titleColumn &&
										!column.hideOnMobile &&
										!isAction(column),
								)
								.map((column) => (
									<Group
										key={column.key}
										gap="xs"
										wrap="nowrap"
										align="flex-start"
									>
										<Text size="xs" c="dimmed" w={96} style={{ flexShrink: 0 }}>
											{column.header}
										</Text>
										<Box fz="sm" style={{ minWidth: 0, flex: 1 }}>
											{column.render(row)}
										</Box>
									</Group>
								))}
						</Stack>
						{actions.length > 0 && (
							<Group gap="xs" justify="flex-end" mt={6}>
								{actions.map((column) => (
									<Box key={column.key}>{column.render(row)}</Box>
								))}
							</Group>
						)}
					</Box>
				);
			})}
		</Stack>
	);

	return (
		<>
			{cards}
			<Box visibleFrom="sm">
				<Table.ScrollContainer minWidth={minWidth}>
					<Table
						highlightOnHover={!!onRowClick}
						verticalSpacing="sm"
						layout={layout}
					>
						<Table.Thead>
							<Table.Tr>
								{columns.map((column) => (
									<Table.Th
										key={column.key}
										w={column.width}
										ta={column.align}
										visibleFrom={column.hideOnMobile ? "sm" : undefined}
									>
										{column.sortValue ? (
											<UnstyledButton
												onClick={() => toggle(column.key)}
												fw={600}
												fz="sm"
											>
												<Group gap={4} wrap="nowrap">
													{column.header}
													{sort?.key === column.key ? (
														sort.direction === "asc" ? (
															<ArrowUp size={12} />
														) : (
															<ArrowDown size={12} />
														)
													) : (
														<ArrowUpDown size={12} opacity={0.4} />
													)}
												</Group>
											</UnstyledButton>
										) : (
											column.header
										)}
									</Table.Th>
								))}
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{sorted.map((row) => (
								<Table.Tr
									key={getRowKey(row)}
									onClick={onRowClick ? () => onRowClick(row) : undefined}
									style={onRowClick ? { cursor: "pointer" } : undefined}
								>
									{columns.map((column) => (
										<Table.Td
											key={column.key}
											ta={column.align}
											visibleFrom={column.hideOnMobile ? "sm" : undefined}
										>
											{column.render(row)}
										</Table.Td>
									))}
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			</Box>
		</>
	);
}
