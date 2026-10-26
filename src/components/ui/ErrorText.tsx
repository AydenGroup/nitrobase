import { useLingui } from "@lingui/react";
import {
	Anchor,
	Code,
	Collapse,
	Stack,
	Text,
	type TextProps,
} from "@mantine/core";
import { useState } from "react";

import { type ErrorInfo, errorDetail, errorText } from "#/libs/coded.ts";

export interface IErrorTextProps extends TextProps {
	error: Partial<ErrorInfo> | null | undefined;
	/** Limit the message to this many lines (full text in the tooltip). */
	lineClamp?: number;
	/** Whether to show the expandable "Details" disclosure for raw output. Default true. */
	withDetail?: boolean;
}

/**
 * A stored or returned error in the reader's language (its code's
 * message, else its untranslated text), with the raw tool output (`detail`
 * param) behind "Details".
 */
export const ErrorText: React.FC<IErrorTextProps> = ({
	error,
	lineClamp,
	withDetail = true,
	...props
}) => {
	const { i18n } = useLingui();
	const [open, setOpen] = useState(false);
	if (!error) return null;
	const message = errorText(i18n, error);
	const detail = withDetail ? errorDetail(error) : undefined;

	if (!detail) {
		return (
			<Text
				size="sm"
				style={{ whiteSpace: "pre-wrap" }}
				lineClamp={lineClamp}
				title={lineClamp ? message : undefined}
				{...props}
			>
				{message}
			</Text>
		);
	}

	return (
		<Stack gap={4}>
			<Text
				size="sm"
				style={{ whiteSpace: "pre-wrap" }}
				lineClamp={lineClamp}
				title={lineClamp ? message : undefined}
				{...props}
			>
				{message}
			</Text>
			<Anchor
				component="button"
				type="button"
				size="xs"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
			>
				{open ? i18n._("Hide details") : i18n._("Details")}
			</Anchor>
			<Collapse expanded={open}>
				<Code block style={{ whiteSpace: "pre-wrap" }}>
					{detail}
				</Code>
			</Collapse>
		</Stack>
	);
};
