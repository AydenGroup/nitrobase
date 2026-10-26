import { useLingui } from "@lingui/react";
import { Modal, Stack, Text } from "@mantine/core";
import type { ServerDTO } from "#/features/servers/schema.ts";
import { ServerForm } from "./ServerForm";

/** Add/edit a server; passing `server` edits it. */
export const ServerFormModal: React.FC<{
	opened: boolean;
	onClose: () => void;
	server?: ServerDTO | null;
}> = ({ opened, onClose, server }) => {
	const { i18n } = useLingui();
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				<Stack gap={0} component="span">
					<Text component="span" fz="lg" fw={600}>
						{server ? i18n._("Edit Server") : i18n._("Add Server")}
					</Text>
					<Text component="span" c="dimmed" size="sm">
						{i18n._("Connect your VPS to start deploying applications.")}
					</Text>
				</Stack>
			}
			size="lg"
			centered
		>
			<ServerForm data={server ?? undefined} onClose={onClose} />
		</Modal>
	);
};
