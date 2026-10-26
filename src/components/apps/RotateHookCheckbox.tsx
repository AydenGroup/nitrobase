import { useLingui } from "@lingui/react";
import { Checkbox, Text } from "@mantine/core";
import { useState } from "react";
import type { RotateHookView } from "#/features/apps/schema.ts";
import { translateTemplateText } from "#/libs/i18n.ts";

/**
 * The template's `on_rotate` step in a rotate dialog: a checkbox (its
 * label), with the text for what ticking it does or what happens without
 * it. Uncontrolled (works inside `modals.openConfirmModal`): reports every
 * change through `onChange`, starting from the template's default.
 */
export const RotateHookCheckbox: React.FC<{
	hook: RotateHookView;
	onChange: (checked: boolean) => void;
}> = ({ hook, onChange }) => {
	const { i18n } = useLingui();
	const [checked, setChecked] = useState(hook.default);
	const text = checked ? hook.description : hook.skipped;
	return (
		<Checkbox
			checked={checked}
			onChange={(event) => {
				setChecked(event.currentTarget.checked);
				onChange(event.currentTarget.checked);
			}}
			label={translateTemplateText(i18n, hook.label)}
			description={
				text ? (
					<Text size="xs" c={checked ? "dimmed" : "orange"} component="span">
						{translateTemplateText(i18n, text)}
					</Text>
				) : undefined
			}
		/>
	);
};
