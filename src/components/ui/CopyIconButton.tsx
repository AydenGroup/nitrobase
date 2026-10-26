import { useLingui } from "@lingui/react";
import { ActionIcon, CopyButton, Tooltip } from "@mantine/core";
import { Check, Copy } from "lucide-react";

/**
 * Icon button copying `value` (read at click time from the latest render),
 * with a tooltip, an accessible name (`label`, default "Copy") and a copied
 * state.
 */
export const CopyIconButton: React.FC<{
	value: string;
	size?: number;
	label?: string;
}> = ({ value, size = 14, label }) => {
	const { i18n } = useLingui();
	const name = label ?? i18n._("Copy");
	return (
		<CopyButton value={value} timeout={1500}>
			{({ copied, copy }) => (
				<Tooltip label={copied ? i18n._("Copied") : name} withArrow>
					<ActionIcon
						variant="subtle"
						color={copied ? "green" : "gray"}
						onClick={copy}
						aria-label={name}
						disabled={!value}
					>
						{copied ? <Check size={size} /> : <Copy size={size} />}
					</ActionIcon>
				</Tooltip>
			)}
		</CopyButton>
	);
};
