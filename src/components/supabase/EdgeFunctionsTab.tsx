import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Alert,
	Button,
	Grid,
	Group,
	JsonInput,
	Menu,
	Modal,
	NavLink,
	SegmentedControl,
	Select,
	Stack,
	Table,
	Tabs,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Play, Plus, Rocket, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import { AppJobDrawer } from "#/components/apps/AppJobDrawer";
import { AppLogsTab } from "#/components/apps/AppLogsTab";
import { useAppJob } from "#/components/apps/useAppJob";
import { ConfirmDanger } from "#/components/ui/ConfirmDanger";
import { EmptyState } from "#/components/ui/EmptyState";
import { notifications } from "#/components/ui/Notifications";
import { SecretInput } from "#/components/ui/SecretInput.tsx";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { APP_NAME } from "#/config/shared.ts";
import { updateServiceEnvFn } from "#/features/apps/apps.functions.ts";
import { serviceEnvQueryOptions } from "#/features/apps/apps.query.ts";
import type { HttpResult } from "#/features/supabase/schema.ts";
import {
	createEdgeFunctionFn,
	deleteEdgeFunctionFn,
	invokeEdgeFunctionFn,
	saveEdgeFunctionFn,
	saveSharedFolderFn,
} from "#/features/supabase/supabase.functions.ts";
import {
	edgeFunctionQueryOptions,
	edgeFunctionsQueryOptions,
	sharedFoldersQueryOptions,
	supabaseOverviewQueryOptions,
} from "#/features/supabase/supabase.query.ts";
import { formatDate } from "#/libs/intl.ts";
import { edgeFunctionStarters } from "#/plugins/supabase/starters.ts";
import type { PluginTabProps } from "#/plugins/types.ts";
import { FILE_PATTERN, FolderFilesEditor } from "./FolderFilesEditor";
import { resolveSelection, type Selection } from "./folderSelection";
import { HttpResultView } from "./HttpResultView";
import { SharedFolderEditor } from "./SharedFolderEditor";
import { useFolderFiles } from "./useFolderFiles";

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
export default function EdgeFunctionsTab({ overview }: PluginTabProps) {
	const { i18n } = useLingui();
	const plugin = useQuery(supabaseOverviewQueryOptions(overview.app.id));
	if (plugin.error) return <Alert color="red">{plugin.error.message}</Alert>;
	if (!plugin.data) return null;
	const service = plugin.data.functionsService;
	if (!overview.services.includes(service)) {
		return (
			<EmptyState
				icon={Zap}
				title={i18n._("Not deployed yet")}
				description={i18n._(
					"Edge Functions are available after the first deploy.",
				)}
			/>
		);
	}
	return (
		<Tabs defaultValue="functions" variant="pills" keepMounted={false}>
			<Tabs.List mb="md">
				<Tabs.Tab value="functions">{i18n._("Functions")}</Tabs.Tab>
				<Tabs.Tab value="secrets">{i18n._("Secrets")}</Tabs.Tab>
				<Tabs.Tab value="logs">{i18n._("Logs")}</Tabs.Tab>
			</Tabs.List>
			<Tabs.Panel value="functions">
				<FunctionsPanel appId={overview.app.id} />
			</Tabs.Panel>
			<Tabs.Panel value="secrets">
				<SecretsPanel overview={overview} service={service} />
			</Tabs.Panel>
			<Tabs.Panel value="logs">
				<AppLogsTab
					overview={overview}
					fixedService={service}
					height="calc(100dvh - 420px)"
				/>
			</Tabs.Panel>
		</Tabs>
	);
}

// ---------------------------------------------------------------------------
// Functions list + editor

function FunctionsPanel({ appId }: { appId: string }) {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const functions = useQuery(edgeFunctionsQueryOptions(appId));
	const shared = useQuery(sharedFoldersQueryOptions(appId));
	const [selected, setSelected] = useState<Selection>(null);
	const [createOpen, setCreateOpen] = useState<"function" | "shared" | null>(
		null,
	);
	const functionList = functions.data ?? [];
	const sharedList = shared.data ?? [];
	const current = resolveSelection(selected, functionList, sharedList);

	const refresh = () => {
		queryClient.invalidateQueries({
			queryKey: edgeFunctionsQueryOptions(appId).queryKey,
		});
		queryClient.invalidateQueries({
			queryKey: sharedFoldersQueryOptions(appId).queryKey,
		});
	};

	if (functions.error) {
		return <Alert color="red">{functions.error.message}</Alert>;
	}
	if (shared.error) return <Alert color="red">{shared.error.message}</Alert>;

	const subtitle = (updatedAt: string | null) =>
		updatedAt
			? formatDate(i18n.locale, updatedAt, {
					dateStyle: "medium",
					timeStyle: "short",
				})
			: undefined;

	return (
		<Grid gap="md">
			<Grid.Col span={{ base: 12, md: 3 }}>
				<SectionCard
					title={i18n._("Functions")}
					actions={
						<Menu position="bottom-end" withinPortal>
							<Menu.Target>
								<ActionIcon variant="light" aria-label={i18n._("New")}>
									<Plus size={16} />
								</ActionIcon>
							</Menu.Target>
							<Menu.Dropdown>
								<Menu.Item
									leftSection={<Zap size={14} />}
									onClick={() => setCreateOpen("function")}
								>
									{i18n._("New function")}
								</Menu.Item>
								<Menu.Item
									leftSection={<FolderPlus size={14} />}
									onClick={() => setCreateOpen("shared")}
								>
									{i18n._("New shared folder")}
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					}
				>
					{functions.isLoading || shared.isLoading ? (
						<Text size="sm" c="dimmed">
							{i18n._("Loading…")}
						</Text>
					) : functionList.length || sharedList.length ? (
						<Stack gap={2}>
							{functionList.map((fn) => (
								<NavLink
									key={`function:${fn.name}`}
									label={fn.name}
									description={subtitle(fn.updatedAt)}
									active={
										current?.kind === "function" && current.name === fn.name
									}
									onClick={() =>
										setSelected({ kind: "function", name: fn.name })
									}
								/>
							))}
							{sharedList.length > 0 && (
								<Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="sm">
									{i18n._("Shared")}
								</Text>
							)}
							{sharedList.map((folder) => (
								<NavLink
									key={`shared:${folder.name}`}
									label={folder.name}
									description={subtitle(folder.updatedAt)}
									active={
										current?.kind === "shared" && current.name === folder.name
									}
									onClick={() =>
										setSelected({ kind: "shared", name: folder.name })
									}
								/>
							))}
						</Stack>
					) : (
						<Text size="sm" c="dimmed">
							{i18n._("No functions yet.")}
						</Text>
					)}
				</SectionCard>
			</Grid.Col>
			<Grid.Col span={{ base: 12, md: 9 }}>
				{current?.kind === "shared" ? (
					<SharedFolderEditor
						key={`shared:${current.name}`}
						appId={appId}
						name={current.name}
						onDeleted={() => {
							setSelected(null);
							refresh();
						}}
						onSaved={refresh}
					/>
				) : current ? (
					<FunctionEditor
						key={`function:${current.name}`}
						appId={appId}
						name={current.name}
						onDeleted={() => {
							setSelected(null);
							refresh();
						}}
						onSaved={refresh}
					/>
				) : (
					<EmptyState
						icon={Zap}
						title={i18n._("No edge functions")}
						description={i18n._(
							"Create a function from a starter, edit it here and deploy it to the edge runtime.",
						)}
						actionLabel={i18n._("New function")}
						action={() => setCreateOpen("function")}
					/>
				)}
			</Grid.Col>
			<NewFunctionModal
				appId={appId}
				opened={createOpen === "function"}
				onClose={() => setCreateOpen(null)}
				onCreated={(name) => {
					setCreateOpen(null);
					setSelected({ kind: "function", name });
					refresh();
				}}
			/>
			<NewSharedFolderModal
				appId={appId}
				opened={createOpen === "shared"}
				onClose={() => setCreateOpen(null)}
				onCreated={(name) => {
					setCreateOpen(null);
					setSelected({ kind: "shared", name });
					refresh();
				}}
			/>
		</Grid>
	);
}

function NewFunctionModal({
	appId,
	opened,
	onClose,
	onCreated,
}: {
	appId: string;
	opened: boolean;
	onClose: () => void;
	onCreated: (name: string) => void;
}) {
	const { i18n } = useLingui();
	const [name, setName] = useState("");
	const [starter, setStarter] = useState(edgeFunctionStarters[0]?.id ?? "");
	const valid = NAME_PATTERN.test(name);
	const create = useAppMutation({
		mutationFn: async () =>
			await createEdgeFunctionFn({ data: { appId, name, starter } }),
		success: i18n._("{name} deployed", { name }),
		field: "name",
		onSuccess: () => {
			setName("");
			onCreated(name);
		},
	});
	const selectedStarter = edgeFunctionStarters.find(
		(item) => item.id === starter,
	);
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={i18n._("New edge function")}
			centered
		>
			<Stack>
				<TextInput
					label={i18n._("Name")}
					description={i18n._(
						"Lowercase letters, digits, - and _. It becomes /functions/v1/<name>.",
					)}
					value={name}
					onChange={(event) => setName(event.currentTarget.value.trim())}
					error={name && !valid ? i18n._("Use a-z, 0-9, - and _") : undefined}
					data-autofocus
				/>
				<Select
					label={i18n._("Starter")}
					data={edgeFunctionStarters.map((item) => ({
						value: item.id,
						label: i18n._(item.label),
					}))}
					value={starter}
					onChange={(value) => value && setStarter(value)}
					allowDeselect={false}
					description={
						selectedStarter ? i18n._(selectedStarter.description) : undefined
					}
				/>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{i18n._("Cancel")}
					</Button>
					<Button
						leftSection={<Rocket size={16} />}
						disabled={!valid}
						loading={create.isPending}
						onClick={() => create.mutate()}
					>
						{i18n._("Create and deploy")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

const SHARED_NAME_PATTERN = /^_[a-z0-9][a-z0-9_-]{0,61}$/;

function NewSharedFolderModal({
	appId,
	opened,
	onClose,
	onCreated,
}: {
	appId: string;
	opened: boolean;
	onClose: () => void;
	onCreated: (name: string) => void;
}) {
	const { i18n } = useLingui();
	const [name, setName] = useState("_shared");
	const [file, setFile] = useState("utils.ts");
	const nameValid = SHARED_NAME_PATTERN.test(name);
	const fileValid = FILE_PATTERN.test(file);
	const create = useAppMutation({
		mutationFn: async () =>
			await saveSharedFolderFn({
				data: {
					appId,
					name,
					files: [{ path: file, content: "" }],
					create: true,
				},
			}),
		success: i18n._("{name} deployed", { name }),
		field: "name",
		onSuccess: () => onCreated(name),
	});
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={i18n._("New shared folder")}
			centered
		>
			<Stack>
				<TextInput
					label={i18n._("Name")}
					description={i18n._(
						"Starts with _ (for example _shared). Import it from a function as ../_shared/file.ts.",
					)}
					value={name}
					onChange={(event) => setName(event.currentTarget.value.trim())}
					error={
						name && !nameValid
							? i18n._("Use _ then a-z, 0-9, - and _")
							: undefined
					}
					data-autofocus
				/>
				<TextInput
					label={i18n._("First file")}
					value={file}
					onChange={(event) => setFile(event.currentTarget.value.trim())}
					error={
						file && !fileValid ? i18n._("Invalid or duplicate path") : undefined
					}
				/>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{i18n._("Cancel")}
					</Button>
					<Button
						leftSection={<Rocket size={16} />}
						disabled={!nameValid || !fileValid}
						loading={create.isPending}
						onClick={() => create.mutate()}
					>
						{i18n._("Create and deploy")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function FunctionEditor({
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
		...edgeFunctionQueryOptions(appId, name),
		refetchOnWindowFocus: false,
	});
	const folder = useFolderFiles(source.data?.files);
	const [deleteOpen, setDeleteOpen] = useState(false);

	const save = useAppMutation({
		mutationFn: async () =>
			await saveEdgeFunctionFn({
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
			await deleteEdgeFunctionFn({ data: { appId, name } }),
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
				description={`/functions/v1/${name}`}
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
						<Tooltip label={i18n._("Delete function")}>
							<ActionIcon
								variant="light"
								color="red"
								size="lg"
								aria-label={i18n._("Delete function")}
								onClick={() => setDeleteOpen(true)}
							>
								<Trash2 size={16} />
							</ActionIcon>
						</Tooltip>
					</>
				}
			>
				<FolderFilesEditor folder={folder} skipped={source.data.skipped} />
			</SectionCard>

			<InvokePanel appId={appId} name={name} />

			<ConfirmDanger
				opened={deleteOpen}
				onClose={() => setDeleteOpen(false)}
				title={i18n._("Delete edge function")}
				description={i18n._(
					"The function folder is removed from the functions volume. Requests to it will fail.",
				)}
				confirmName={name}
				confirmLabel={i18n._("Delete")}
				loading={remove.isPending}
				onConfirm={() => remove.mutate()}
			/>
		</Stack>
	);
}

const METHODS = ["POST", "GET", "PUT", "PATCH", "DELETE"] as const;

function InvokePanel({ appId, name }: { appId: string; name: string }) {
	const { i18n } = useLingui();
	const [method, setMethod] = useState<(typeof METHODS)[number]>("POST");
	const [key, setKey] = useState<"anon" | "service">("anon");
	const [body, setBody] = useState(JSON.stringify({ name: APP_NAME }, null, 2));
	const [result, setResult] = useState<HttpResult | null>(null);
	const invoke = useAppMutation({
		mutationFn: async () =>
			await invokeEdgeFunctionFn({
				data: {
					appId,
					name,
					method,
					key,
					body: method === "GET" ? undefined : body,
				},
			}),
		onSuccess: setResult,
	});
	return (
		<SectionCard
			title={i18n._("Invoke")}
			description={i18n._(
				"Sent from the server to the app's API gateway with the chosen key.",
			)}
		>
			<Stack gap="sm">
				<Group align="flex-end">
					<Select
						label={i18n._("Method")}
						data={[...METHODS]}
						value={method}
						onChange={(value) =>
							value && setMethod(value as (typeof METHODS)[number])
						}
						allowDeselect={false}
						w={120}
					/>
					<Stack gap={4}>
						<Text size="sm" fw={500}>
							{i18n._("Authorization")}
						</Text>
						<SegmentedControl
							value={key}
							onChange={(value) => setKey(value as "anon" | "service")}
							data={[
								{ value: "anon", label: "anon" },
								{ value: "service", label: "service_role" },
							]}
						/>
					</Stack>
					<Button
						leftSection={<Play size={16} />}
						loading={invoke.isPending}
						onClick={() => invoke.mutate()}
					>
						{i18n._("Send")}
					</Button>
				</Group>
				{method !== "GET" && (
					<JsonInput
						label={i18n._("JSON body")}
						value={body}
						onChange={setBody}
						validationError={i18n._("Invalid JSON")}
						formatOnBlur
						autosize
						minRows={3}
						maxRows={12}
					/>
				)}
				{result && <HttpResultView result={result} />}
			</Stack>
		</SectionCard>
	);
}

// ---------------------------------------------------------------------------
// Secrets (service-scoped env of the edge runtime; values are write-only)

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

function SecretsPanel({
	overview,
	service,
}: {
	overview: PluginTabProps["overview"];
	service: string;
}) {
	const { i18n } = useLingui();
	const appId = overview.app.id;
	const queryClient = useQueryClient();
	const jobs = useAppJob(appId);
	const secrets = useQuery(serviceEnvQueryOptions(appId, service));
	const [editing, setEditing] = useState<{
		name: string;
		isNew: boolean;
	} | null>(null);
	const [value, setValue] = useState("");

	const mutate = useAppMutation({
		mutationFn: async (edit: {
			set?: Record<string, string>;
			remove?: string[];
		}) =>
			await updateServiceEnvFn({
				data: {
					appId,
					service,
					set: edit.set ?? {},
					remove: edit.remove ?? [],
				},
			}),
		// Refusals while editing show under the name field.
		field: (edit) => (edit.set ? "name" : undefined),
		success: ({ deploymentId }) =>
			deploymentId ? i18n._("Secrets saved") : null,
		onSuccess: ({ deploymentId }) => {
			setEditing(null);
			setValue("");
			queryClient.invalidateQueries({
				queryKey: serviceEnvQueryOptions(appId, service).queryKey,
			});
			if (deploymentId) {
				jobs.openJob(deploymentId, i18n._("Update function secrets"));
			} else {
				notifications.info({
					message: i18n._(
						"Saved. Redeploy the app to make the functions read their secrets.",
					),
				});
				jobs.refresh();
			}
		},
	});

	const confirmRemove = (name: string) =>
		modals.openConfirmModal({
			title: i18n._("Remove secret"),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._("{name} is removed and the functions service is restarted.", {
						name,
					})}
				</Text>
			),
			labels: { confirm: i18n._("Remove"), cancel: i18n._("Cancel") },
			confirmProps: { color: "red" },
			onConfirm: () => mutate.mutate({ remove: [name] }),
		});

	const nameValid = !!editing && SECRET_NAME.test(editing.name);

	return (
		<Stack gap="md">
			{secrets.data && !secrets.data.applied && (
				<Alert color="yellow" title={i18n._("Redeploy needed")}>
					{i18n._(
						"This app was deployed before function secrets existed. Redeploy it once so the functions service reads its secrets file.",
					)}
				</Alert>
			)}
			<SectionCard
				title={i18n._("Function secrets")}
				description={i18n._(
					"Environment variables of the edge runtime, shared by every function (Deno.env.get). Values are encrypted and never shown again.",
				)}
				actions={
					<Button
						size="xs"
						leftSection={<Plus size={14} />}
						onClick={() => {
							setValue("");
							setEditing({ name: "", isNew: true });
						}}
					>
						{i18n._("Add secret")}
					</Button>
				}
				flush
			>
				{secrets.error ? (
					<Alert color="red" m="md">
						{secrets.error.message}
					</Alert>
				) : secrets.data?.names.length ? (
					<Table>
						<Table.Tbody>
							{secrets.data.names.map((name) => (
								<Table.Tr key={name}>
									<Table.Td>
										<Text ff="monospace" size="sm">
											{name}
										</Text>
									</Table.Td>
									<Table.Td c="dimmed">********</Table.Td>
									<Table.Td>
										<Group gap="xs" justify="flex-end">
											<Button
												size="xs"
												variant="default"
												onClick={() => {
													setValue("");
													setEditing({ name, isNew: false });
												}}
											>
												{i18n._("Update")}
											</Button>
											<ActionIcon
												variant="subtle"
												color="red"
												aria-label={i18n._("Remove secret")}
												onClick={() => confirmRemove(name)}
											>
												<Trash2 size={14} />
											</ActionIcon>
										</Group>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				) : (
					<Text size="sm" c="dimmed" p="md">
						{i18n._("No secrets yet.")}
					</Text>
				)}
			</SectionCard>
			<Modal
				opened={editing !== null}
				onClose={() => setEditing(null)}
				title={editing?.isNew ? i18n._("Add secret") : i18n._("Update secret")}
				centered
			>
				<Stack>
					<TextInput
						label={i18n._("Name")}
						autoComplete="off"
						value={editing?.name ?? ""}
						disabled={!editing?.isNew}
						onChange={(event) => {
							mutate.clearFieldError();
							setEditing({
								name: event.currentTarget.value.toUpperCase().trim(),
								isNew: true,
							});
						}}
						error={
							editing?.name && !nameValid
								? i18n._("Use A-Z, 0-9 and _, not starting with a digit")
								: mutate.fieldError("name")
						}
						data-autofocus
					/>
					<SecretInput
						label={i18n._("Value")}
						value={value}
						onChange={(event) => setValue(event.currentTarget.value)}
						autoComplete="off"
					/>
					<Text size="xs" c="dimmed">
						{i18n._(
							"Saving restarts the functions service so the new value is used.",
						)}
					</Text>
					<Group justify="flex-end">
						<Button
							disabled={!nameValid}
							loading={mutate.isPending}
							onClick={() =>
								editing && mutate.mutate({ set: { [editing.name]: value } })
							}
						>
							{i18n._("Save")}
						</Button>
					</Group>
				</Stack>
			</Modal>
			<AppJobDrawer
				job={jobs.job}
				appName={overview.app.name}
				onClose={jobs.closeJob}
				onCompleted={() => jobs.refresh()}
			/>
		</Stack>
	);
}
