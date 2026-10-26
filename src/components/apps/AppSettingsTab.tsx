import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	Card,
	Checkbox,
	Code,
	Group,
	Modal,
	ScrollArea,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { BackupFirstCheckbox } from "#/components/backups/BackupFirstCheckbox";
import { DatabaseVersionCard } from "#/components/databases/DatabaseVersionCard";
import { GitAppSettings } from "#/components/git/GitAppSettings";
import { useCanOnApp } from "#/components/teams/useCan";
import { CodedList } from "#/components/ui/CodedList.tsx";
import { notifications } from "#/components/ui/Notifications";
import { appSources } from "#/config/app-sources.ts";
import {
	appActionFn,
	deleteAppFn,
	previewAppUpdateFn,
} from "#/features/apps/apps.functions.ts";
import type { AppOverview, AppUpdatePreview } from "#/features/apps/schema.ts";
import { templateVersionsQueryOptions } from "#/features/templates/templates.query.ts";
import { formatDate, formatList } from "#/libs/intl.ts";
import { AppJobDrawer } from "./AppJobDrawer";
import { AppPortsCard } from "./AppPortsCard";
import { AppResourcesCard } from "./AppResourcesCard";
import { AppTasksCard } from "./AppTasksCard";
import { CustomComposeCard } from "./CustomComposeCard";
import { MoveAppCard } from "./MoveAppCard";
import { useAppJob } from "./useAppJob";

export const AppSettingsTab: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { i18n } = useLingui();
	const can = useCanOnApp(overview.sourceKind === "database");
	const { app } = overview;
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const jobs = useAppJob(app.id);
	const [includePrereleases, setIncludePrereleases] = useState(false);
	const [version, setVersion] = useState<string | null>(null);
	const [preview, setPreview] = useState<AppUpdatePreview | null>(null);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [confirmName, setConfirmName] = useState("");
	const [wipeData, setWipeData] = useState(false);
	const [removeImages, setRemoveImages] = useState(false);
	const [backupBeforeDelete, setBackupBeforeDelete] = useState(false);
	const [backupBeforeUpdate, setBackupBeforeUpdate] = useState(false);
	const [deleteJobId, setDeleteJobId] = useState<string | null>(null);
	const versions = useQuery({
		...templateVersionsQueryOptions(app.templateId, includePrereleases),
		enabled: appSources[overview.sourceKind].versioned,
	});
	// Versions are listed newest first: a later index is an older release.
	const versionIndex = (ref: string | undefined) =>
		(versions.data?.versions ?? []).findIndex((item) => item.ref === ref);
	const isDowngrade =
		!!preview &&
		versionIndex(preview.version) > -1 &&
		versionIndex(app.version) > -1 &&
		versionIndex(preview.version) > versionIndex(app.version);

	const previewUpdate = useMutation({
		mutationFn: async (target: string) =>
			await previewAppUpdateFn({ data: { appId: app.id, version: target } }),
		onSuccess: setPreview,
		onError: (error: Error) => notifications.error({ message: error.message }),
	});

	const remove = useMutation({
		mutationFn: async () =>
			await deleteAppFn({
				data: {
					appId: app.id,
					confirmName,
					wipeData,
					removeImages,
					backupFirst: backupBeforeDelete,
				},
			}),
		onSuccess: ({ deploymentId }) => {
			setDeleteOpen(false);
			setDeleteJobId(deploymentId);
			jobs.openJob(deploymentId, i18n._("Delete app"));
		},
		onError: (error: Error) => notifications.error({ message: error.message }),
	});

	return (
		<Stack gap="md">
			{overview.sourceKind === "git" ? (
				<GitAppSettings overview={overview} />
			) : overview.sourceKind === "database" ? (
				can("database.manage") && (
					<DatabaseVersionCard overview={overview} jobs={jobs} />
				)
			) : !can("app.deploy") ? null : overview.customCompose ? (
				<CustomComposeCard overview={overview} jobs={jobs} />
			) : (
				<Card withBorder p="md">
					<Title order={5} mb="xs">
						{i18n._("Change version")}
					</Title>
					<Text size="sm" c="dimmed" mb="sm">
						{i18n._("Current: {version}", { version: app.version })}
					</Text>
					<Group align="flex-end">
						<Select
							label={i18n._("Version")}
							data={(versions.data?.versions ?? []).map((item) => ({
								value: item.ref,
								label: item.publishedAt
									? `${item.name} (${formatDate(i18n.locale, item.publishedAt, { dateStyle: "medium" })})`
									: item.name,
							}))}
							value={version}
							onChange={setVersion}
							searchable
							w={320}
						/>
						<Switch
							label={i18n._("Show pre-releases")}
							mb={8}
							checked={includePrereleases}
							onChange={(event) =>
								setIncludePrereleases(event.currentTarget.checked)
							}
						/>
						<Button
							variant="light"
							disabled={!version}
							loading={previewUpdate.isPending}
							onClick={() => version && previewUpdate.mutate(version)}
						>
							{i18n._("Preview changes")}
						</Button>
					</Group>
				</Card>
			)}

			{can("app.env.edit") && <AppPortsCard overview={overview} />}
			{can("app.resources.manage") && <AppResourcesCard overview={overview} />}
			{can("app.view") && <AppTasksCard overview={overview} />}

			{can("app.move") && <MoveAppCard overview={overview} jobs={jobs} />}

			<Card
				withBorder
				p="md"
				style={{ borderColor: "var(--mantine-color-red-6)" }}
				display={can("app.delete") ? undefined : "none"}
			>
				<Title order={5} mb="xs" c="red">
					{overview.sourceKind === "database"
						? i18n._("Delete database")
						: i18n._("Delete app")}
				</Title>
				<Text size="sm" c="dimmed" mb="sm">
					{overview.sourceKind === "database"
						? i18n._(
								"Stops and removes the database container. Unlink every app first; tick “delete all data” to also remove its volume.",
							)
						: i18n._("Stops and removes the containers and the app's routes.")}
				</Text>
				<Button color="red" variant="light" onClick={() => setDeleteOpen(true)}>
					{overview.sourceKind === "database"
						? i18n._("Delete database")
						: i18n._("Delete app")}
				</Button>
			</Card>

			<Modal
				opened={preview !== null}
				onClose={() => setPreview(null)}
				title={
					isDowngrade
						? i18n._("Downgrade to {version}", {
								version: preview?.version ?? "",
							})
						: i18n._("Update to {version}", { version: preview?.version ?? "" })
				}
				size="xl"
			>
				{preview && (
					<Stack>
						{isDowngrade && (
							<Alert color="orange" title={i18n._("This is an older version")}>
								{i18n._(
									"Database migrations of newer versions may not be reversible. Take a backup before downgrading.",
								)}
							</Alert>
						)}
						<Text size="sm">
							{i18n._("Commit")} <Code>{preview.commitSha.slice(0, 12)}</Code>
						</Text>
						{preview.warnings.length > 0 && (
							<Alert color="yellow">
								<CodedList items={preview.warnings} />
							</Alert>
						)}
						<Text size="sm" fw={600}>
							{i18n._("Environment")}
						</Text>
						<Text size="sm" c="dimmed">
							{i18n._(
								"Added: {added} · Removed: {removed} · Changed: {changed}",
								{
									added: formatList(i18n.locale, preview.env.added, "unit"),
									removed: formatList(i18n.locale, preview.env.removed, "unit"),
									changed: formatList(i18n.locale, preview.env.changed, "unit"),
								},
							)}
						</Text>
						<Text size="sm" fw={600}>
							docker-compose.yml
						</Text>
						{preview.composeChanged ? (
							<ScrollArea h={360}>
								<Code block>{preview.composeDiff}</Code>
							</ScrollArea>
						) : (
							<Text size="sm" c="dimmed">
								{i18n._("No changes.")}
							</Text>
						)}
						<BackupFirstCheckbox
							appId={app.id}
							checked={backupBeforeUpdate}
							onChange={setBackupBeforeUpdate}
						/>
						<Group justify="flex-end">
							<Button variant="default" onClick={() => setPreview(null)}>
								{i18n._("Cancel")}
							</Button>
							<Button
								loading={jobs.isStarting}
								onClick={() => {
									const target = preview.version;
									setPreview(null);
									jobs.startJob({
										title: i18n._("Change version"),
										start: () =>
											appActionFn({
												data: {
													appId: app.id,
													action: "update",
													version: target,
													backupFirst: backupBeforeUpdate,
												},
											}),
									});
								}}
							>
								{i18n._("Apply update")}
							</Button>
						</Group>
					</Stack>
				)}
			</Modal>

			<Modal
				opened={deleteOpen}
				onClose={() => setDeleteOpen(false)}
				title={i18n._("Delete app")}
			>
				<Stack>
					<Text size="sm">
						{i18n._("Type {name} to confirm.", { name: app.folder })}
					</Text>
					<TextInput
						value={confirmName}
						onChange={(event) => setConfirmName(event.currentTarget.value)}
					/>
					<Checkbox
						label={i18n._(
							"Also delete all data (volumes and the app folder). This cannot be undone.",
						)}
						checked={wipeData}
						onChange={(event) => setWipeData(event.currentTarget.checked)}
						color="red"
					/>
					<Checkbox
						label={i18n._(
							"Also remove the app's images (images still used by other containers are kept).",
						)}
						checked={removeImages}
						onChange={(event) => setRemoveImages(event.currentTarget.checked)}
					/>
					<BackupFirstCheckbox
						appId={app.id}
						checked={backupBeforeDelete}
						onChange={setBackupBeforeDelete}
					/>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setDeleteOpen(false)}>
							{i18n._("Cancel")}
						</Button>
						<Button
							color="red"
							disabled={confirmName.trim() !== app.folder}
							loading={remove.isPending}
							onClick={() => remove.mutate()}
						>
							{i18n._("Delete")}
						</Button>
					</Group>
				</Stack>
			</Modal>
			<AppJobDrawer
				job={jobs.job}
				appName={app.name}
				onClose={jobs.closeJob}
				onCompleted={(success?: boolean) => {
					if (deleteJobId && jobs.job?.id === deleteJobId && success) {
						// The app is gone: leave its page before refetching it.
						jobs.closeJob();
						if (overview.sourceKind === "database") {
							navigate({ to: "/{-$locale}/databases" });
							queryClient.invalidateQueries({ queryKey: ["databases"] });
						} else {
							navigate({ to: "/{-$locale}/apps" });
						}
						queryClient.invalidateQueries({ queryKey: ["apps"], exact: true });
						return;
					}
					jobs.refresh();
				}}
			/>
		</Stack>
	);
};
