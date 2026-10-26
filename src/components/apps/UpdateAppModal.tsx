import { useLingui } from "@lingui/react";
import { Anchor, Button, Code, Group, Modal, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { BackupFirstCheckbox } from "#/components/backups/BackupFirstCheckbox";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { updateAppFn } from "#/features/app-updates/app-updates.functions.ts";
import type { AppUpdateView } from "#/features/app-updates/schema.ts";
import { rollbackLabels, updateKindLabels } from "./update-labels";

/**
 * One-click update: from → to, release notes, what happens on failure,
 * "Back up first" (on when a destination exists).
 */
export const UpdateAppModal: React.FC<{
	appId: string;
	appName: string;
	update: AppUpdateView | null;
	onClose: () => void;
	onStarted: (deploymentId: string, title: string) => void;
}> = ({ appId, appName, update, onClose, onStarted }) => {
	const { i18n } = useLingui();
	const [backupFirst, setBackupFirst] = useState(true);
	const start = useAppMutation({
		mutationFn: async () =>
			await updateAppFn({
				data: {
					appId,
					version: update?.version ?? undefined,
					backupFirst,
				},
			}),
		field: "update",
		onSuccess: ({ deploymentId }) => {
			onStarted(deploymentId, i18n._("Update {name}", { name: appName }));
			onClose();
		},
	});
	const target = update?.name ?? update?.version ?? "";
	return (
		<Modal
			opened={!!update}
			onClose={onClose}
			title={i18n._("Update {name}", { name: appName })}
		>
			{update && (
				<Stack>
					<Group gap="xs">
						<Code>{update.current}</Code>
						<Text size="sm">→</Text>
						<Code>{target}</Code>
						{update.kind && (
							<Text size="sm" c="dimmed">
								({i18n._(updateKindLabels[update.kind])})
							</Text>
						)}
					</Group>
					{update.url && (
						<Anchor
							href={update.url}
							target="_blank"
							rel="noreferrer"
							size="sm"
						>
							{i18n._("Release notes")}
						</Anchor>
					)}
					<Text size="sm">{i18n._(rollbackLabels[update.rollback])}</Text>
					<BackupFirstCheckbox
						appId={appId}
						checked={backupFirst}
						onChange={setBackupFirst}
					/>
					{start.fieldError() && (
						<Text size="sm" c="red">
							{start.fieldError()}
						</Text>
					)}
					<Group justify="flex-end">
						<Button variant="default" onClick={onClose}>
							{i18n._("Cancel")}
						</Button>
						<Button loading={start.isPending} onClick={() => start.mutate()}>
							{i18n._("Update to {version}", { version: target })}
						</Button>
					</Group>
				</Stack>
			)}
		</Modal>
	);
};
