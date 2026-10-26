import { useLingui } from "@lingui/react";
import {
	Alert,
	Badge,
	Button,
	Checkbox,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { LocalDate } from "#/components/ui/LocalDate";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	listWorkDirsFn,
	sweepWorkDirsFn,
} from "#/features/backups/backups.functions.ts";
import { formatBytes } from "#/libs/intl.ts";

/**
 * "Clean up leftovers now": every backup staging folder on the server, any
 * age. The owner picks what to remove (folders a running job uses can't be
 * picked); the automatic sweep only removes folders older than the longest
 * job.
 */
export const WorkDirsCleanupModal: React.FC<{
	serverId: string;
	opened: boolean;
	onClose: () => void;
	onStarted: (deploymentId: string) => void;
}> = ({ serverId, opened, onClose, onStarted }) => {
	const { i18n } = useLingui();
	const dirs = useQuery({
		queryKey: ["servers", serverId, "work-dirs"],
		queryFn: async () => await listWorkDirsFn({ data: serverId }),
		enabled: opened,
		staleTime: 0,
	});
	const [selected, setSelected] = useState<string[]>([]);
	useEffect(() => {
		if (dirs.data) {
			setSelected(dirs.data.filter((dir) => !dir.inUse).map((dir) => dir.path));
		}
	}, [dirs.data]);
	const sweep = useAppMutation({
		mutationFn: async () =>
			await sweepWorkDirsFn({ data: { serverId, paths: selected } }),
		onSuccess: ({ deploymentId }) => {
			onClose();
			onStarted(deploymentId);
		},
	});
	const rows = dirs.data ?? [];
	const total = rows
		.filter((dir) => selected.includes(dir.path))
		.reduce((sum, dir) => sum + dir.sizeKb * 1024, 0);

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={i18n._("Clean up leftovers")}
			size="lg"
			centered
		>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					{i18n._(
						"Backup staging folders on this server. A crashed or cancelled job can leave one behind (it may hold destination credentials). Folders of finished jobs and folders older than the longest job are always removed; pick any others to remove now.",
					)}
				</Text>
				{dirs.isLoading ? (
					<Loader size="sm" />
				) : dirs.error ? (
					<Alert color="red">{dirs.error.message}</Alert>
				) : rows.length === 0 ? (
					<Text size="sm">{i18n._("No staging folders on this server.")}</Text>
				) : (
					<Stack gap={6}>
						{rows.map((dir) => (
							<Group key={dir.path} justify="space-between" wrap="nowrap">
								<Checkbox
									disabled={dir.inUse}
									checked={selected.includes(dir.path)}
									onChange={(event) => {
										const checked = event.currentTarget.checked;
										setSelected((prev) =>
											checked
												? [...prev, dir.path]
												: prev.filter((path) => path !== dir.path),
										);
									}}
									label={
										<Text
											size="sm"
											ff="monospace"
											style={{ wordBreak: "break-all" }}
										>
											{dir.path.split("/").pop()}
										</Text>
									}
								/>
								<Group gap="xs" wrap="nowrap">
									{dir.inUse && (
										<Badge size="xs" color="blue" variant="light">
											{i18n._("In use")}
										</Badge>
									)}
									<Text size="xs" c="dimmed">
										{formatBytes(i18n.locale, dir.sizeKb * 1024)}
									</Text>
									<Text size="xs" c="dimmed">
										<LocalDate value={dir.modifiedAt} />
									</Text>
								</Group>
							</Group>
						))}
					</Stack>
				)}
				<Group justify="flex-end" mt="sm">
					<Button variant="default" onClick={onClose}>
						{i18n._("Cancel")}
					</Button>
					<Button
						color="red"
						loading={sweep.isPending}
						disabled={dirs.isLoading}
						onClick={() => sweep.mutate()}
					>
						{selected.length
							? i18n._("Remove {count} folders ({size})", {
									count: selected.length,
									size: formatBytes(i18n.locale, total),
								})
							: i18n._("Run the automatic cleanup")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
