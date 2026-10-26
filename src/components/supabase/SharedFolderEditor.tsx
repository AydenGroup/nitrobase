import { useLingui } from "@lingui/react";
import { ActionIcon, Alert, Button, Stack, Text, Tooltip } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Rocket, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDanger } from "#/components/ui/ConfirmDanger";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	deleteSharedFolderFn,
	saveSharedFolderFn,
} from "#/features/supabase/supabase.functions.ts";
import { sharedFolderQueryOptions } from "#/features/supabase/supabase.query.ts";
import { FolderFilesEditor } from "./FolderFilesEditor";
import { useFolderFiles } from "./useFolderFiles";

/** Editor of a shared code folder (`_shared`, `lib`...): not callable, so no invoke panel. */
export function SharedFolderEditor({
	appId,
	name,
	onDeleted,
	onSaved,
}: {
	appId: string;
	name: string;
	onDeleted: () => void;
	onSaved: () => void;
}) {
	const { i18n } = useLingui();
	const source = useQuery({
		...sharedFolderQueryOptions(appId, name),
		refetchOnWindowFocus: false,
	});
	const folder = useFolderFiles(source.data?.files);
	const [deleteOpen, setDeleteOpen] = useState(false);

	const save = useAppMutation({
		mutationFn: async () =>
			await saveSharedFolderFn({
				data: { appId, name, files: folder.working },
			}),
		success: i18n._("{name} deployed", { name }),
		onSuccess: () => {
			folder.discard();
			source.refetch();
			onSaved();
		},
	});

	const remove = useAppMutation({
		mutationFn: async () =>
			await deleteSharedFolderFn({ data: { appId, name } }),
		success: i18n._("{name} deleted", { name }),
		onSuccess: () => {
			setDeleteOpen(false);
			onDeleted();
		},
	});

	if (source.error) return <Alert color="red">{source.error.message}</Alert>;
	if (!source.data) {
		return (
			<Text size="sm" c="dimmed">
				{i18n._("Loading…")}
			</Text>
		);
	}

	return (
		<Stack gap="md">
			<SectionCard
				title={name}
				description={i18n._("Shared code, not served as a function")}
				actions={
					<>
						<Button
							leftSection={<Rocket size={16} />}
							loading={save.isPending}
							disabled={folder.working.length === 0}
							onClick={() => save.mutate()}
						>
							{folder.dirty ? i18n._("Save and deploy") : i18n._("Redeploy")}
						</Button>
						<Tooltip label={i18n._("Delete shared folder")}>
							<ActionIcon
								variant="light"
								color="red"
								size="lg"
								aria-label={i18n._("Delete shared folder")}
								onClick={() => setDeleteOpen(true)}
							>
								<Trash2 size={16} />
							</ActionIcon>
						</Tooltip>
					</>
				}
			>
				<Stack gap="sm">
					<Alert color="blue">
						{i18n._(
							"Changes apply to every function that imports this folder, and the functions service restarts.",
						)}
					</Alert>
					<FolderFilesEditor folder={folder} skipped={source.data.skipped} />
				</Stack>
			</SectionCard>

			<ConfirmDanger
				opened={deleteOpen}
				onClose={() => setDeleteOpen(false)}
				title={i18n._("Delete shared folder")}
				description={i18n._(
					"The folder is removed from the functions volume. Functions that import it will fail until it is restored.",
				)}
				confirmName={name}
				confirmLabel={i18n._("Delete")}
				loading={remove.isPending}
				onConfirm={() => remove.mutate()}
			/>
		</Stack>
	);
}
