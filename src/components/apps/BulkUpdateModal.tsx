import { useLingui } from "@lingui/react";
import {
	Anchor,
	Badge,
	Button,
	Checkbox,
	Code,
	Group,
	Modal,
	Stack,
	Table,
	Text,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ErrorText } from "#/components/ui/ErrorText.tsx";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { bulkUpdateAppsFn } from "#/features/app-updates/app-updates.functions.ts";
import { updateBatchQueryOptions } from "#/features/app-updates/app-updates.query.ts";
import type { AppUpdateView } from "#/features/app-updates/schema.ts";
import { AppJobDrawer } from "./AppJobDrawer";
import { updateResultColors, updateResultLabels } from "./update-labels";

/**
 * Bulk update: confirm the apps, then follow the queue (one update at a
 * time per server, each with its backup and rollback) until the summary.
 */
export const BulkUpdateModal: React.FC<{
	opened: boolean;
	onClose: () => void;
	apps: { id: string; name: string; update: AppUpdateView }[];
}> = ({ opened, onClose, apps }) => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const [backupFirst, setBackupFirst] = useState(true);
	const [batchId, setBatchId] = useState<string | null>(null);
	const [job, setJob] = useState<{ id: string; title: string } | null>(null);
	const start = useAppMutation({
		mutationFn: async () =>
			await bulkUpdateAppsFn({
				data: { appIds: apps.map((app) => app.id), backupFirst },
			}),
		field: "bulk",
		onSuccess: (batch) => setBatchId(batch.id),
	});
	const batch = useQuery({
		...updateBatchQueryOptions(batchId ?? ""),
		enabled: !!batchId,
	});
	const finished = !!batch.data?.finishedAt;
	useEffect(() => {
		if (finished) {
			void queryClient.invalidateQueries({ queryKey: ["app-updates"] });
			void queryClient.invalidateQueries({ queryKey: ["apps"] });
		}
	}, [finished, queryClient]);
	const close = () => {
		setBatchId(null);
		onClose();
	};

	return (
		<Modal
			opened={opened}
			onClose={close}
			size="lg"
			title={i18n._("Update {count, plural, one {# app} other {# apps}}", {
				// Once started, the batch's own list (updated apps leave `apps`).
				count: batchId ? (batch.data?.items.length ?? 0) : apps.length,
			})}
		>
			{!batchId ? (
				<Stack>
					<Text size="sm">
						{i18n._(
							"Updates run one at a time per server, after the server's other jobs. Each one backs up first (when chosen) and rolls back when it fails.",
						)}
					</Text>
					<Table>
						<Table.Tbody>
							{apps.map((app) => (
								<Table.Tr key={app.id}>
									<Table.Td>{app.name}</Table.Td>
									<Table.Td>
										<Code>{app.update.current}</Code> →{" "}
										<Code>{app.update.name ?? app.update.version}</Code>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
					<Checkbox
						label={i18n._(
							"Back up each app first (to its default destination)",
						)}
						checked={backupFirst}
						onChange={(event) => setBackupFirst(event.currentTarget.checked)}
					/>
					{start.fieldError() && (
						<Text size="sm" c="red">
							{start.fieldError()}
						</Text>
					)}
					<Group justify="flex-end">
						<Button variant="default" onClick={close}>
							{i18n._("Cancel")}
						</Button>
						<Button
							loading={start.isPending}
							disabled={apps.length === 0}
							onClick={() => start.mutate()}
						>
							{i18n._("Start updates")}
						</Button>
					</Group>
				</Stack>
			) : (
				<Stack>
					<Text size="sm" c="dimmed">
						{finished
							? i18n._("All updates have finished.")
							: i18n._(
									"Updating... you can close this window, the updates go on.",
								)}
					</Text>
					<Table>
						<Table.Tbody>
							{(batch.data?.items ?? []).map((item) => (
								<Table.Tr key={item.appId}>
									<Table.Td>
										<Text size="sm">{item.appName}</Text>
										<Text size="xs" c="dimmed">
											{item.serverName}
										</Text>
									</Table.Td>
									<Table.Td>
										<Code>{item.from}</Code> → <Code>{item.to}</Code>
									</Table.Td>
									<Table.Td>
										<Badge
											variant="light"
											color={updateResultColors[item.status]}
										>
											{i18n._(updateResultLabels[item.status])}
										</Badge>
										<ErrorText size="xs" c="dimmed" error={item.error} />
									</Table.Td>
									<Table.Td>
										{item.deploymentId && (
											<Anchor
												size="xs"
												component="button"
												onClick={() =>
													setJob({
														id: item.deploymentId as string,
														title: i18n._("Update {name}", {
															name: item.appName,
														}),
													})
												}
											>
												{i18n._("View log")}
											</Anchor>
										)}
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
					<Group justify="flex-end">
						<Button variant="default" onClick={close}>
							{i18n._("Close")}
						</Button>
					</Group>
				</Stack>
			)}
			<AppJobDrawer
				job={job}
				appName={job?.title ?? ""}
				onClose={() => setJob(null)}
				onCompleted={() => undefined}
			/>
		</Modal>
	);
};
