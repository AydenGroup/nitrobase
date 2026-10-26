import { useLingui } from "@lingui/react";
import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";

/** Destructive action confirmation that requires typing a name. */
export const ConfirmDanger: React.FC<{
	opened: boolean;
	onClose: () => void;
	title: string;
	description: ReactNode;
	/** Text the user must type exactly. */
	confirmName: string;
	confirmLabel: string;
	loading?: boolean;
	onConfirm: (typed: string) => void;
	/** Extra options (e.g. a "wipe data" checkbox). */
	children?: ReactNode;
	/** Why the last attempt was refused (shown inline). */
	error?: string;
}> = ({
	opened,
	onClose,
	title,
	description,
	confirmName,
	confirmLabel,
	loading,
	onConfirm,
	children,
	error,
}) => {
	const { i18n } = useLingui();
	const [typed, setTyped] = useState("");
	useEffect(() => {
		if (!opened) setTyped("");
	}, [opened]);
	const matches = typed.trim() === confirmName;
	return (
		<Modal opened={opened} onClose={onClose} title={title} centered>
			<Stack>
				<Text size="sm" component="div">
					{description}
				</Text>
				<TextInput
					label={i18n._("Type {name} to confirm.", { name: confirmName })}
					value={typed}
					onChange={(event) => setTyped(event.currentTarget.value)}
					data-autofocus
					autoComplete="off"
				/>
				{children}
				{error && (
					<Text size="sm" c="red" style={{ whiteSpace: "pre-wrap" }}>
						{error}
					</Text>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{i18n._("Cancel")}
					</Button>
					<Button
						color="red"
						disabled={!matches}
						loading={loading}
						onClick={() => onConfirm(typed)}
					>
						{confirmLabel}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
