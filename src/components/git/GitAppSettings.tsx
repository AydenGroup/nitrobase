import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Code,
	Group,
	NumberInput,
	Stack,
	Switch,
	Table,
	Text,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useCan } from "#/components/teams/useCan";
import { CopyField } from "#/components/ui/CopyField";
import { LocalDate } from "#/components/ui/LocalDate";
import { SecretField } from "#/components/ui/SecretField";
import { SectionCard } from "#/components/ui/SectionCard";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { builders } from "#/config/builders.ts";
import { WEBHOOK_HEADERS } from "#/config/identifiers.ts";
import { deliveryStatuses } from "#/config/status.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import {
	editBuildSecretsFn,
	revealWebhookSecretFn,
	rotateWebhookSecretFn,
	setWebhookEnabledFn,
	updateBuildSettingsFn,
	updateGitSourceFn,
} from "#/features/git/git.functions.ts";
import {
	deliveriesQueryOptions,
	gitAppQueryOptions,
} from "#/features/git/git.query.ts";
import type {
	BuildSettings,
	GitAppView,
	GitCredentialView,
	GitSource,
	RuntimeSettings,
} from "#/features/git/schema.ts";
import { formatList } from "#/libs/intl.ts";
import { parseEnvText } from "./env-text";
import {
	BuildSecretsField,
	GitBuildFields,
	GitRuntimeFields,
	GitSourceFields,
} from "./GitForms";
import { deliveryReasonText, gitAuthLabels } from "./labels";

/** App → Settings of a git app: Source, Build & runtime, Webhook. */
export const GitAppSettings: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { data: git } = useQuery(gitAppQueryOptions(overview.app.id));
	if (!git) return null;
	return (
		<>
			<GitSourceCard appId={overview.app.id} git={git} />
			<GitBuildCard appId={overview.app.id} git={git} />
			<GitWebhookCard appId={overview.app.id} git={git} />
		</>
	);
};

function useRefreshGit(appId: string) {
	const queryClient = useQueryClient();
	return () => queryClient.invalidateQueries({ queryKey: ["apps", appId] });
}

const GitSourceCard: React.FC<{ appId: string; git: GitAppView }> = ({
	appId,
	git,
}) => {
	const { i18n } = useLingui();
	const can = useCan();
	const refresh = useRefreshGit(appId);
	const [editing, setEditing] = useState(false);
	const initial: GitSource = {
		repoUrl: git.source.repoUrl,
		branch: git.source.branch,
		subdir: git.source.subdir,
		submodules: git.source.submodules,
		auth: git.source.auth,
		credentialId: git.source.credentialId,
		allowPrivateHost: git.source.allowPrivateHost,
	};
	const [value, setValue] = useState<GitSource>(initial);
	const [credential, setCredential] = useState<GitCredentialView | null>(
		git.credential,
	);
	const save = useAppMutation({
		mutationFn: async () =>
			await updateGitSourceFn({ data: { appId, source: value } }),
		success: i18n._("Repository settings saved: the next build uses them"),
		onSuccess: async () => {
			setEditing(false);
			await refresh();
		},
		field: "source",
	});
	return (
		<SectionCard
			title={i18n._("Source")}
			description={i18n._("Where the code is fetched from for every build.")}
			actions={
				can("app.source.manage") &&
				!editing && (
					<Button
						size="xs"
						variant="light"
						onClick={() => {
							setValue(initial);
							setCredential(git.credential);
							setEditing(true);
						}}
					>
						{i18n._("Edit")}
					</Button>
				)
			}
		>
			{editing ? (
				<Stack>
					<GitSourceFields
						value={value}
						onChange={setValue}
						credential={credential}
						onCredential={setCredential}
						appId={appId}
						error={save.fieldError()}
					/>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setEditing(false)}>
							{i18n._("Cancel")}
						</Button>
						<Button loading={save.isPending} onClick={() => save.mutate()}>
							{i18n._("Save")}
						</Button>
					</Group>
				</Stack>
			) : (
				<Stack gap="xs">
					<Group gap="xs">
						<Code>{git.source.repoUrl}</Code>
						<Badge variant="light">{git.source.branch}</Badge>
						{git.source.subdir && (
							<Badge variant="outline">{git.source.subdir}</Badge>
						)}
					</Group>
					<Text size="sm" c="dimmed">
						{i18n._(gitAuthLabels[git.source.auth])}
						{git.credential?.fingerprint
							? ` · ${git.credential.fingerprint}`
							: ""}
					</Text>
					{git.credential?.publicKey && (
						<CopyField value={git.credential.publicKey} block />
					)}
				</Stack>
			)}
		</SectionCard>
	);
};

const GitBuildCard: React.FC<{ appId: string; git: GitAppView }> = ({
	appId,
	git,
}) => {
	const { i18n } = useLingui();
	const can = useCan();
	const refresh = useRefreshGit(appId);
	const [build, setBuild] = useState<BuildSettings>(git.build);
	const [runtime, setRuntime] = useState<RuntimeSettings>(git.runtime);
	const [keepImages, setKeepImages] = useState<number | null>(git.keepImages);
	const [secretsText, setSecretsText] = useState("");
	useEffect(() => {
		setBuild(git.build);
		setRuntime(git.runtime);
		setKeepImages(git.keepImages);
	}, [git]);
	const editable = can("app.source.manage");
	const save = useAppMutation({
		mutationFn: async () =>
			await updateBuildSettingsFn({
				data: { appId, build, runtime, keepImages },
			}),
		success: i18n._("Build settings saved"),
		onSuccess: refresh,
	});
	const secrets = parseEnvText(secretsText);
	const saveSecrets = useAppMutation({
		mutationFn: async (remove: string[]) =>
			await editBuildSecretsFn({
				data: { appId, set: secrets.values, remove },
			}),
		success: i18n._("Build secrets saved: the next build uses them"),
		onSuccess: async () => {
			setSecretsText("");
			await refresh();
		},
	});
	return (
		<SectionCard
			title={i18n._("Build and runtime")}
			description={
				git.detectedBuilder
					? i18n._("Last detection: {builder}", {
							builder: i18n._(builders[git.detectedBuilder].label),
						})
					: undefined
			}
		>
			<Stack>
				<GitBuildFields
					value={build}
					onChange={setBuild}
					detection={null}
					defaults={git.defaults.limits}
					maxTimeoutSeconds={git.defaults.maxTimeoutSeconds}
				/>
				<GitRuntimeFields value={runtime} onChange={setRuntime} />
				<NumberInput
					label={i18n._("Images kept for rollback")}
					description={i18n._(
						"Older images are removed after each deploy; the running one is always kept.",
					)}
					min={1}
					maw={280}
					placeholder={String(git.defaults.keepImages)}
					value={keepImages ?? ""}
					onChange={(next) =>
						setKeepImages(typeof next === "number" ? next : null)
					}
				/>
				{editable && (
					<Group justify="flex-end">
						<Button loading={save.isPending} onClick={() => save.mutate()}>
							{i18n._("Save build settings")}
						</Button>
					</Group>
				)}
				<Stack gap={4}>
					<Text size="sm" fw={500}>
						{i18n._("Build secrets")}
					</Text>
					{git.buildSecretNames.length === 0 ? (
						<Text size="sm" c="dimmed">
							{i18n._("None.")}
						</Text>
					) : (
						<Group gap="xs">
							{git.buildSecretNames.map((secretName) => (
								<Badge
									key={secretName}
									variant="outline"
									rightSection={
										editable && (
											<ActionIcon
												size="xs"
												variant="transparent"
												color="gray"
												aria-label={i18n._("Remove {name}", {
													name: secretName,
												})}
												onClick={() => saveSecrets.mutate([secretName])}
											>
												<X size={12} />
											</ActionIcon>
										)
									}
								>
									{secretName}
								</Badge>
							))}
						</Group>
					)}
					{editable && (
						<>
							<BuildSecretsField
								editing
								value={secretsText}
								onChange={setSecretsText}
							/>
							<Group justify="flex-end">
								<Button
									variant="light"
									disabled={
										!Object.keys(secrets.values).length ||
										secrets.invalid.length > 0
									}
									loading={saveSecrets.isPending}
									onClick={() => saveSecrets.mutate([])}
								>
									{i18n._("Add or replace secrets")}
								</Button>
							</Group>
						</>
					)}
				</Stack>
			</Stack>
		</SectionCard>
	);
};

const GitWebhookCard: React.FC<{ appId: string; git: GitAppView }> = ({
	appId,
	git,
}) => {
	const { i18n } = useLingui();
	const can = useCan();
	const refresh = useRefreshGit(appId);
	const editable = can("app.source.manage");
	const { data: deliveries = [] } = useQuery(deliveriesQueryOptions(appId));
	const [origin, setOrigin] = useState("");
	useEffect(() => setOrigin(window.location.origin), []);
	const toggle = useAppMutation({
		mutationFn: async (enabled: boolean) =>
			await setWebhookEnabledFn({ data: { appId, enabled } }),
		onSuccess: refresh,
	});
	const rotate = useAppMutation({
		mutationFn: async () => await rotateWebhookSecretFn({ data: appId }),
		success: i18n._(
			"New webhook URL and secret: update them in your repository's webhook settings",
		),
		onSuccess: refresh,
	});
	const url = `${origin}${git.webhook.path}`;
	return (
		<SectionCard
			title={i18n._("Push webhook")}
			description={i18n._(
				"Add this URL and secret as a push webhook (content type application/json) in {providers}. Pushes to {branch} build and deploy the new commit.",
				{
					providers: formatList(i18n.locale, git.webhook.providers, "unit"),
					branch: git.source.branch,
				},
			)}
			actions={
				editable && (
					<Switch
						label={i18n._("Enabled")}
						checked={git.webhook.enabled}
						onChange={(event) => toggle.mutate(event.currentTarget.checked)}
					/>
				)
			}
		>
			<Stack gap="sm">
				<Stack gap={2}>
					<Text size="sm" fw={500}>
						{i18n._("Payload URL")}
					</Text>
					<CopyField value={url} />
				</Stack>
				{editable && (
					<Stack gap={2}>
						<Text size="sm" fw={500}>
							{i18n._("Secret")}
						</Text>
						<SecretField
							name={i18n._("The push webhook secret")}
							onReveal={async () =>
								(await revealWebhookSecretFn({ data: appId })).secret
							}
						/>
						<Text size="xs" c="dimmed">
							{i18n._(
								"GitHub and Gitea/Forgejo sign with it (HMAC-SHA256); GitLab sends it as the secret token. Other senders: {signatureHeader} = sha256=HMAC(secret, timestamp.body) with {timestampHeader}.",
								{
									signatureHeader: WEBHOOK_HEADERS.signature,
									timestampHeader: WEBHOOK_HEADERS.timestamp,
								},
							)}
						</Text>
					</Stack>
				)}
				{editable && (
					<Group>
						<Button
							size="xs"
							variant="subtle"
							color="red"
							loading={rotate.isPending}
							onClick={() =>
								modals.openConfirmModal({
									title: i18n._("Rotate webhook secret?"),
									centered: true,
									children: (
										<Text size="sm">
											{i18n._(
												"The URL and the secret both change; pushes stop deploying until the repository's webhook is updated.",
											)}
										</Text>
									),
									labels: {
										confirm: i18n._("Rotate"),
										cancel: i18n._("Cancel"),
									},
									onConfirm: () => rotate.mutate(),
								})
							}
						>
							{i18n._("Rotate URL and secret")}
						</Button>
					</Group>
				)}
				<Text size="sm" fw={500}>
					{i18n._("Recent deliveries")}
				</Text>
				{deliveries.length === 0 ? (
					<Text size="sm" c="dimmed">
						{i18n._("No deliveries yet.")}
					</Text>
				) : (
					<Table.ScrollContainer minWidth={560}>
						<Table>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>{i18n._("Received")}</Table.Th>
									<Table.Th>{i18n._("Status")}</Table.Th>
									<Table.Th>{i18n._("Branch")}</Table.Th>
									<Table.Th>{i18n._("Commit")}</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{deliveries.map((delivery) => (
									<Table.Tr key={delivery.id}>
										<Table.Td>
											<Text size="sm">
												<LocalDate value={delivery.createdAt} />
											</Text>
											<Text size="xs" c="dimmed">
												{delivery.provider}
											</Text>
										</Table.Td>
										<Table.Td>
											<StatusBadge meta={deliveryStatuses[delivery.status]} />
											{delivery.reason && (
												<Text size="xs" c="dimmed">
													{deliveryReasonText(i18n, delivery.reason)}
												</Text>
											)}
										</Table.Td>
										<Table.Td>{delivery.branch ?? "—"}</Table.Td>
										<Table.Td>
											{delivery.commitSha ? (
												<Code>{delivery.commitSha.slice(0, 12)}</Code>
											) : (
												"—"
											)}
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					</Table.ScrollContainer>
				)}
				{!git.webhook.enabled && (
					<Alert color="yellow" variant="light">
						{i18n._(
							"The webhook is off: pushes are recorded but not deployed.",
						)}
					</Alert>
				)}
			</Stack>
		</SectionCard>
	);
};
