import { useLingui } from "@lingui/react";
import { ActionIcon, Code, Group, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { Eye } from "lucide-react";
import { useState } from "react";
import { SECRET_MASK } from "#/libs/env-file.ts";
import { CopyField } from "./CopyField";
import { notifications } from "./Notifications";

/**
 * Confirm-then-reveal flow for secrets. `reveal` is called only after the
 * user confirms (the server records the reveal in the audit log).
 */
export function useRevealConfirm() {
	const { i18n } = useLingui();
	return (name: string, reveal: () => Promise<void>) =>
		modals.openConfirmModal({
			title: i18n._("Reveal secret"),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._(
						"{name} will be shown in plain text and the reveal is recorded in the audit log.",
						{ name },
					)}
				</Text>
			),
			labels: { confirm: i18n._("Reveal"), cancel: i18n._("Cancel") },
			onConfirm: () => {
				reveal().catch((error: Error) =>
					notifications.error({ message: error.message }),
				);
			},
		});
}

/** Masked secret value with reveal-on-confirm, then copy. */
export const SecretField: React.FC<{
	name: string;
	/** Fetch the plain value (audited server-side). */
	onReveal: () => Promise<string>;
}> = ({ name, onReveal }) => {
	const { i18n } = useLingui();
	const confirm = useRevealConfirm();
	const [value, setValue] = useState<string | null>(null);
	if (value !== null) return <CopyField value={value} />;
	return (
		<Group gap={4} wrap="nowrap">
			<Code style={{ flex: 1 }}>{SECRET_MASK}</Code>
			<Tooltip label={i18n._("Reveal")} withArrow>
				<ActionIcon
					variant="subtle"
					color="gray"
					aria-label={i18n._("Reveal")}
					onClick={() => confirm(name, async () => setValue(await onReveal()))}
				>
					<Eye size={14} />
				</ActionIcon>
			</Tooltip>
		</Group>
	);
};
