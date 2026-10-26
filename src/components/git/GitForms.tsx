import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Alert,
	Button,
	Group,
	NumberInput,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { CopyField } from "#/components/ui/CopyField";
import { SecretInput } from "#/components/ui/SecretInput.tsx";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { autoBuilderLabel, builders } from "#/config/builders.ts";
import { APP_NAME } from "#/config/shared.ts";
import { createGitCredentialFn } from "#/features/git/git.functions.ts";
import {
	BUILDER_CHOICES,
	type BuilderChoice,
	type BuilderDetection,
	type BuildSettings,
	GIT_AUTH_KINDS,
	type GitAuthKind,
	type GitCredentialView,
	type GitSource,
	RUNTIME_VOLUMES_MAX,
	type RuntimeSettings,
} from "#/features/git/schema.ts";
import { formatList } from "#/libs/intl.ts";
import { envText, parseEnvText } from "./env-text";
import { detectionReasonText, gitAuthLabels } from "./labels";

/**
 * Form sections of git apps, shared by the deploy wizard and the app's
 * Settings: repository (with the deploy key / token), build, runtime.
 */

export const GitSourceFields: React.FC<{
	value: GitSource;
	onChange: (value: GitSource) => void;
	credential: GitCredentialView | null;
	onCredential: (credential: GitCredentialView | null) => void;
	/** Existing app (credential created for it). */
	appId?: string;
	error?: string;
}> = ({ value, onChange, credential, onCredential, appId, error }) => {
	const { i18n } = useLingui();
	const set = (patch: Partial<GitSource>) => onChange({ ...value, ...patch });
	const [username, setUsername] = useState("x-access-token");
	const [token, setToken] = useState("");
	const create = useAppMutation({
		mutationFn: async (kind: Exclude<GitAuthKind, "none">) =>
			await createGitCredentialFn({
				data:
					kind === "deploy_key"
						? { kind, appId }
						: { kind, appId, username, token },
			}),
		onSuccess: (view) => {
			setToken("");
			onCredential(view);
			set({ credentialId: view.id, auth: view.kind });
		},
		field: "credential",
	});
	const usable =
		credential && credential.kind === value.auth ? credential : null;
	return (
		<Stack gap="sm">
			<TextInput
				label={i18n._("Repository URL")}
				placeholder="https://github.com/owner/repo.git"
				description={i18n._(
					"HTTPS for public repositories or with an access token; SSH (git@host:owner/repo.git) with a deploy key.",
				)}
				value={value.repoUrl}
				error={error}
				onChange={(event) => set({ repoUrl: event.currentTarget.value })}
			/>
			<Group grow align="flex-start">
				<TextInput
					label={i18n._("Branch")}
					placeholder="main"
					value={value.branch}
					onChange={(event) => set({ branch: event.currentTarget.value })}
				/>
				<TextInput
					label={i18n._("Folder in the repository")}
					description={i18n._("For monorepos; empty = the repository root.")}
					placeholder="apps/web"
					value={value.subdir}
					onChange={(event) => set({ subdir: event.currentTarget.value })}
				/>
			</Group>
			<Stack gap={4}>
				<Text size="sm" fw={500}>
					{i18n._("Access")}
				</Text>
				<SegmentedControl
					value={value.auth}
					onChange={(auth) =>
						set({
							auth: auth as GitAuthKind,
							credentialId:
								credential && credential.kind === auth ? credential.id : null,
						})
					}
					data={GIT_AUTH_KINDS.map((kind) => ({
						value: kind,
						label: i18n._(gitAuthLabels[kind]),
					}))}
				/>
			</Stack>
			{value.auth === "deploy_key" &&
				(usable ? (
					<Stack gap={4}>
						<Text size="sm">
							{i18n._(
								"Add this public key to the repository as a read-only deploy key (GitHub: {github}; GitLab: {gitlab}; Gitea/Forgejo: {gitea}).",
								{
									github: "Settings → Deploy keys",
									gitlab: "Settings → Repository → Deploy keys",
									gitea: "Settings → Deploy keys",
								},
							)}
						</Text>
						<CopyField value={usable.publicKey ?? ""} block />
						{usable.fingerprint && (
							<Text size="xs" c="dimmed">
								{usable.fingerprint}
							</Text>
						)}
					</Stack>
				) : (
					<Group>
						<Button
							variant="light"
							loading={create.isPending}
							onClick={() => create.mutate("deploy_key")}
						>
							{i18n._("Generate deploy key")}
						</Button>
						<Text size="xs" c="dimmed">
							{i18n._(
								"An ed25519 key made for this app; the private key never leaves {appName}.",
								{ appName: APP_NAME },
							)}
						</Text>
					</Group>
				))}
			{value.auth === "token" &&
				(usable ? (
					<Group gap="xs">
						<Text size="sm">
							{i18n._("Token saved for user {name}.", {
								name: usable.username ?? "",
							})}
						</Text>
						<Button
							size="xs"
							variant="subtle"
							onClick={() => {
								onCredential(null);
								set({ credentialId: null });
							}}
						>
							{i18n._("Replace")}
						</Button>
					</Group>
				) : (
					<Group align="flex-end" grow>
						<TextInput
							label={i18n._("User name")}
							description={i18n._(
								"Any name works for most hosts with a token.",
							)}
							autoComplete="off"
							value={username}
							onChange={(event) => setUsername(event.currentTarget.value)}
						/>
						<SecretInput
							label={i18n._("Access token")}
							description={i18n._(
								"Read-only access to the repository is enough.",
							)}
							value={token}
							onChange={(event) => setToken(event.currentTarget.value)}
						/>
						<Button
							variant="light"
							disabled={!token.trim() || !username.trim()}
							loading={create.isPending}
							onClick={() => create.mutate("token")}
						>
							{i18n._("Save token")}
						</Button>
					</Group>
				))}
			{create.fieldError() && (
				<Alert color="red" variant="light">
					{create.fieldError()}
				</Alert>
			)}
			<Switch
				label={i18n._("Private network host")}
				description={i18n._(
					"Allow a Git server on a private or local address (e.g. a self-hosted Gitea). Off, such hosts are refused.",
				)}
				checked={value.allowPrivateHost}
				onChange={(event) =>
					set({ allowPrivateHost: event.currentTarget.checked })
				}
			/>
			<Switch
				label={i18n._("Fetch submodules")}
				description={i18n._(
					"One level, checked with the same rules as the repository URL.",
				)}
				checked={value.submodules}
				onChange={(event) => set({ submodules: event.currentTarget.checked })}
			/>
		</Stack>
	);
};

/** Builder choice and its options, plus build limits and secrets. */
export const GitBuildFields: React.FC<{
	value: BuildSettings;
	onChange: (value: BuildSettings) => void;
	detection: BuilderDetection | null;
	defaults: { memoryMb: number; cpus: number; timeoutSeconds: number } | null;
	maxTimeoutSeconds?: number;
}> = ({ value, onChange, detection, defaults, maxTimeoutSeconds }) => {
	const { i18n } = useLingui();
	const [argsText, setArgsText] = useState(envText(value.dockerfile.buildArgs));
	const [argsError, setArgsError] = useState<string | null>(null);
	const set = (patch: Partial<BuildSettings>) =>
		onChange({ ...value, ...patch });
	const effective =
		value.builder === "auto" ? (detection?.builder ?? null) : value.builder;
	return (
		<Stack gap="sm">
			<Select
				label={i18n._("Builder")}
				allowDeselect={false}
				value={value.builder}
				onChange={(builder) =>
					builder && set({ builder: builder as BuilderChoice })
				}
				data={BUILDER_CHOICES.map((choice) => ({
					value: choice,
					label:
						choice === "auto"
							? i18n._(autoBuilderLabel)
							: i18n._(builders[choice].label),
				}))}
				description={
					detection
						? i18n._("Detected: {builder} ({reason})", {
								builder: detection.builder
									? i18n._(builders[detection.builder].label)
									: "—",
								reason: detectionReasonText(i18n, detection.reason),
							})
						: undefined
				}
			/>
			{effective && (
				<Text size="xs" c="dimmed">
					{i18n._(builders[effective].description)}
				</Text>
			)}
			{effective === "dockerfile" && (
				<>
					<Group grow align="flex-start">
						<TextInput
							label={i18n._("Dockerfile path")}
							value={value.dockerfile.path}
							onChange={(event) =>
								set({
									dockerfile: {
										...value.dockerfile,
										path: event.currentTarget.value,
									},
								})
							}
						/>
						<TextInput
							label={i18n._("Build target (stage)")}
							placeholder={i18n._("Last stage")}
							value={value.dockerfile.target ?? ""}
							onChange={(event) =>
								set({
									dockerfile: {
										...value.dockerfile,
										target: event.currentTarget.value.trim() || null,
									},
								})
							}
						/>
					</Group>
					<Textarea
						label={i18n._("Build arguments")}
						description={i18n._(
							"KEY=value per line, passed as --build-arg. Not for secrets: use build secrets.",
						)}
						autosize
						minRows={2}
						styles={{
							input: { fontFamily: "var(--mantine-font-family-monospace)" },
						}}
						value={argsText}
						error={argsError}
						onChange={(event) => {
							const text = event.currentTarget.value;
							setArgsText(text);
							const parsed = parseEnvText(text);
							setArgsError(
								parsed.invalid.length
									? i18n._("Invalid names: {names}", {
											names: formatList(i18n.locale, parsed.invalid, "unit"),
										})
									: null,
							);
							set({
								dockerfile: { ...value.dockerfile, buildArgs: parsed.values },
							});
						}}
					/>
				</>
			)}
			{effective === "static" && (
				<>
					<TextInput
						label={i18n._("Build command")}
						description={i18n._(
							"Runs in the build image; empty = serve the files as they are.",
						)}
						placeholder={
							value.builder === "auto" ? detection?.buildCommand : undefined
						}
						value={value.static.buildCommand}
						onChange={(event) =>
							set({
								static: {
									...value.static,
									buildCommand: event.currentTarget.value,
								},
							})
						}
					/>
					<Group grow align="flex-start">
						<TextInput
							label={i18n._("Output folder")}
							value={value.static.outputDir}
							placeholder={
								value.builder === "auto" ? detection?.outputDir : undefined
							}
							onChange={(event) =>
								set({
									static: {
										...value.static,
										outputDir: event.currentTarget.value,
									},
								})
							}
						/>
						<TextInput
							label={i18n._("Build image")}
							placeholder={i18n._("Default (Node.js)")}
							value={value.static.buildImage ?? ""}
							onChange={(event) =>
								set({
									static: {
										...value.static,
										buildImage: event.currentTarget.value.trim() || null,
									},
								})
							}
						/>
					</Group>
					{value.builder === "auto" && (
						<Text size="xs" c="dimmed">
							{i18n._(
								"With automatic detection, the detected command and folder are used; choose Static site to set your own.",
							)}
						</Text>
					)}
				</>
			)}
			<Group grow align="flex-start">
				<NumberInput
					label={i18n._("Build memory (MB)")}
					min={256}
					placeholder={defaults ? String(defaults.memoryMb) : undefined}
					value={value.limits.memoryMb ?? ""}
					onChange={(next) =>
						set({
							limits: {
								...value.limits,
								memoryMb: typeof next === "number" ? next : null,
							},
						})
					}
				/>
				<NumberInput
					label={i18n._("Build CPUs")}
					min={0.1}
					step={0.5}
					decimalScale={2}
					placeholder={defaults ? String(defaults.cpus) : undefined}
					value={value.limits.cpus ?? ""}
					onChange={(next) =>
						set({
							limits: {
								...value.limits,
								cpus: typeof next === "number" ? next : null,
							},
						})
					}
				/>
				<NumberInput
					label={i18n._("Build timeout (seconds)")}
					min={30}
					max={maxTimeoutSeconds}
					placeholder={defaults ? String(defaults.timeoutSeconds) : undefined}
					value={value.limits.timeoutSeconds ?? ""}
					onChange={(next) =>
						set({
							limits: {
								...value.limits,
								timeoutSeconds: typeof next === "number" ? next : null,
							},
						})
					}
				/>
			</Group>
		</Stack>
	);
};

/** Secrets textarea (create): never shown back once stored. */
export const BuildSecretsField: React.FC<{
	value: string;
	onChange: (text: string) => void;
	/** Settings: secrets are added/replaced, never shown back. */
	editing?: boolean;
}> = ({ value, onChange, editing = false }) => {
	const { i18n } = useLingui();
	const invalid = parseEnvText(value).invalid;
	return (
		<Textarea
			label={
				editing ? i18n._("New or replaced secrets") : i18n._("Build secrets")
			}
			description={i18n._(
				"KEY=value per line. Given to the build as BuildKit secrets (RUN --mount=type=secret,id=KEY), never as build arguments or image layers. Stored encrypted.",
			)}
			autosize
			minRows={2}
			styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
			value={value}
			error={
				invalid.length
					? i18n._("Invalid names: {names}", {
							names: formatList(i18n.locale, invalid, "unit"),
						})
					: undefined
			}
			onChange={(event) => onChange(event.currentTarget.value)}
		/>
	);
};

/** Port, health path and declared volumes of the running app. */
export const GitRuntimeFields: React.FC<{
	value: RuntimeSettings;
	onChange: (value: RuntimeSettings) => void;
}> = ({ value, onChange }) => {
	const { i18n } = useLingui();
	const set = (patch: Partial<RuntimeSettings>) =>
		onChange({ ...value, ...patch });
	return (
		<Stack gap="sm">
			<Group grow align="flex-start">
				<NumberInput
					label={i18n._("Port")}
					description={i18n._(
						"The port your app listens on; also set as the PORT variable.",
					)}
					min={1}
					max={65535}
					value={value.port}
					onChange={(next) => typeof next === "number" && set({ port: next })}
				/>
				<TextInput
					label={i18n._("Health check path")}
					description={i18n._(
						"Probed after each deploy (e.g. /health); empty = the container running is enough.",
					)}
					placeholder="/"
					value={value.healthPath}
					onChange={(event) =>
						set({ healthPath: event.currentTarget.value.trim() })
					}
				/>
			</Group>
			<Stack gap={4}>
				<Text size="sm" fw={500}>
					{i18n._("Persistent volumes")}
				</Text>
				<Text size="xs" c="dimmed">
					{i18n._(
						"Named volumes kept across deploys and included in backups. Everything else in the container is replaced on each deploy.",
					)}
				</Text>
				{value.volumes.map((volume, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own (the name is edited in place); only appended/removed.
					<Group key={index} gap="xs" wrap="nowrap">
						<TextInput
							aria-label={i18n._("Volume name")}
							placeholder="data"
							value={volume.name}
							onChange={(event) => {
								const name = event.currentTarget.value;
								set({
									volumes: value.volumes.map((item, i) =>
										i === index ? { ...item, name } : item,
									),
								});
							}}
						/>
						<TextInput
							aria-label={i18n._("Mount path in the container")}
							placeholder="/app/data"
							style={{ flex: 1 }}
							value={volume.mountPath}
							onChange={(event) => {
								const mountPath = event.currentTarget.value;
								set({
									volumes: value.volumes.map((item, i) =>
										i === index ? { ...item, mountPath } : item,
									),
								});
							}}
						/>
						<ActionIcon
							variant="subtle"
							color="red"
							aria-label={i18n._("Remove volume {name}", {
								name: volume.name,
							})}
							onClick={() =>
								set({ volumes: value.volumes.filter((_, i) => i !== index) })
							}
						>
							<Trash2 size={14} />
						</ActionIcon>
					</Group>
				))}
				{value.volumes.length < RUNTIME_VOLUMES_MAX && (
					<Button
						size="xs"
						variant="subtle"
						leftSection={<Plus size={14} />}
						style={{ alignSelf: "flex-start" }}
						onClick={() =>
							set({
								volumes: [
									...value.volumes,
									{
										name: value.volumes.length
											? `data${value.volumes.length + 1}`
											: "data",
										mountPath: "/data",
									},
								],
							})
						}
					>
						{i18n._("Add volume")}
					</Button>
				)}
			</Stack>
		</Stack>
	);
};
