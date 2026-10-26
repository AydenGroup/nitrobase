import { useLingui } from "@lingui/react";
import { Modal, Stack, Text } from "@mantine/core";
import type { SSHKeyDTO } from "#/features/ssh_keys/schema.ts";
import { SSHKeyForm } from "./SSHKeyForm";

/** Add/edit an SSH key; passing `sshKey` edits it. */
export const SSHKeyFormModal: React.FC<{
	opened: boolean;
	onClose: () => void;
	sshKey?: SSHKeyDTO | null;
}> = ({ opened, onClose, sshKey }) => {
	const { i18n } = useLingui();
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				<Stack gap={0} component="span">
					<Text component="span" fz="lg" fw={600}>
						{sshKey ? i18n._("Edit SSH Key") : i18n._("Add SSH Key")}
					</Text>
					<Text component="span" c="dimmed" size="sm">
						{i18n._("Store SSH keys to easily reuse them across your servers.")}
					</Text>
				</Stack>
			}
			size="lg"
			centered
		>
			<SSHKeyForm data={sshKey ?? undefined} onClose={onClose} />
		</Modal>
	);
};
