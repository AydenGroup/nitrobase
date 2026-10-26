import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Alert,
	Button,
	Group,
	Modal,
	SegmentedControl,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { FilePlus, Trash2 } from "lucide-react";
import { useState } from "react";
import { CodeEditor, type CodeLanguage } from "#/components/ui/CodeEditor";
import { formatList } from "#/libs/intl.ts";
import type { FolderFiles } from "./useFolderFiles";

export const FILE_PATTERN =
	/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}(\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99})*$/;

function languageFor(path: string): CodeLanguage {
	if (/\.(ts|tsx|mts)$/.test(path)) return "typescript";
	if (/\.(js|mjs|jsx|json)$/.test(path)) return "javascript";
	return "plaintext";
}

/** File tabs, add / remove file and the code editor of one folder. */
export function FolderFilesEditor({
	folder,
	skipped,
}: {
	folder: FolderFiles;
	skipped: string[];
}) {
	const { i18n } = useLingui();
	const { working, dirty, setFiles } = folder;
	const [active, setActive] = useState<string | null>(null);
	const [newFile, setNewFile] = useState<string | null>(null);

	const activeFile =
		working.find((file) => file.path === active) ??
		working.find((file) => file.path === "index.ts") ??
		working[0];

	const update = (path: string, content: string) =>
		setFiles(
			working.map((file) => (file.path === path ? { ...file, content } : file)),
		);

	const removeFile = (path: string) =>
		modals.openConfirmModal({
			title: i18n._("Remove file"),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._("{path} is removed on the next deploy.", { path })}
				</Text>
			),
			labels: { confirm: i18n._("Remove"), cancel: i18n._("Cancel") },
			confirmProps: { color: "red" },
			onConfirm: () => {
				setFiles(working.filter((file) => file.path !== path));
				setActive(null);
			},
		});

	const newFileValid =
		!!newFile &&
		FILE_PATTERN.test(newFile) &&
		!working.some((file) => file.path === newFile);

	return (
		<>
			<Stack gap="sm">
				{skipped.length > 0 && (
					<Alert color="yellow">
						{i18n._(
							"Not editable here (symlinks or unsupported names), kept out of deploys: {files}",
							{ files: formatList(i18n.locale, skipped, "unit") },
						)}
					</Alert>
				)}
				<Group gap="xs">
					<SegmentedControl
						size="xs"
						data={working.map((file) => file.path)}
						value={activeFile?.path ?? ""}
						onChange={setActive}
					/>
					<Tooltip label={i18n._("Add file")}>
						<ActionIcon
							variant="subtle"
							aria-label={i18n._("Add file")}
							onClick={() => setNewFile("")}
						>
							<FilePlus size={16} />
						</ActionIcon>
					</Tooltip>
					{activeFile && working.length > 1 && (
						<Tooltip label={i18n._("Remove file")}>
							<ActionIcon
								variant="subtle"
								color="red"
								aria-label={i18n._("Remove file")}
								onClick={() => removeFile(activeFile.path)}
							>
								<Trash2 size={14} />
							</ActionIcon>
						</Tooltip>
					)}
				</Group>
				{activeFile && (
					<CodeEditor
						key={activeFile.path}
						label={activeFile.path}
						value={activeFile.content}
						onChange={(value) => update(activeFile.path, value)}
						language={languageFor(activeFile.path)}
						height="50vh"
					/>
				)}
				{dirty && (
					<Text size="xs" c="yellow">
						{i18n._("Unsaved changes: deploy to apply them.")}
					</Text>
				)}
			</Stack>
			<Modal
				opened={newFile !== null}
				onClose={() => setNewFile(null)}
				title={i18n._("Add file")}
				centered
			>
				<Stack>
					<TextInput
						label={i18n._("Path")}
						placeholder="utils/cors.ts"
						value={newFile ?? ""}
						onChange={(event) => setNewFile(event.currentTarget.value.trim())}
						error={
							newFile && !newFileValid
								? i18n._("Invalid or duplicate path")
								: undefined
						}
						data-autofocus
					/>
					<Group justify="flex-end">
						<Button
							disabled={!newFileValid}
							onClick={() => {
								if (!newFile) return;
								setFiles([...working, { path: newFile, content: "" }]);
								setActive(newFile);
								setNewFile(null);
							}}
						>
							{i18n._("Add")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}
