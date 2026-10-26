import { useLingui } from "@lingui/react";
import { List, type ListProps } from "@mantine/core";
import { type ErrorInfo, errorText } from "#/libs/coded.ts";

/** Coded messages (e.g. compose warnings) as a list in the reader's language. */
export const CodedList: React.FC<
	Omit<ListProps, "children"> & {
		items: Partial<ErrorInfo>[];
		/** Show at most this many. */
		max?: number;
	}
> = ({ items, max, ...props }) => {
	const { i18n } = useLingui();
	return (
		<List size="xs" {...props}>
			{items.slice(0, max).map((item, index) => (
				// Coded items have no id; the order is stable.
				// biome-ignore lint/suspicious/noArrayIndexKey: static list
				<List.Item key={index}>{errorText(i18n, item)}</List.Item>
			))}
		</List>
	);
};
