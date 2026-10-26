import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	Card,
	Checkbox,
	Code,
	Group,
	Loader,
	NumberInput,
	Select,
	Stack,
	Stepper,
	Switch,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckCircle2, CircleAlert, CircleX } from "lucide-react";
import { useEffect, useState } from "react";
import { useFreeDomainProvider } from "#/components/apps/useFreeDomainProvider";
import {
	liveServerStatus,
	useUnreachableServers,
} from "#/components/monitoring/ServerLiveStatus";
import { localizedTemplate } from "#/components/templates/localized.ts";
import { TemplateWarnings } from "#/components/templates/TemplateMeta";
import { KeyValueList } from "#/components/ui/KeyValueList";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { builders } from "#/config/builders.ts";
import { renderCheckDetail } from "#/config/check-details.ts";
import { preflightLabels } from "#/config/preflight.ts";
import { EXAMPLES } from "#/config/shared.ts";
import { createAppFn, preflightFn } from "#/features/apps/apps.functions.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import type { PreflightResult } from "#/features/apps/schema.ts";
import { inspectRepoFn } from "#/features/git/git.functions.ts";
import {
	type BuildSettings,
	BuildSettingsSchema,
	DEFAULT_APP_PORT,
	type GitCredentialView,
	type GitSource,
	type RepoInspection,
	type RuntimeSettings,
} from "#/features/git/schema.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import type { TemplateSummary } from "#/features/templates/schema.ts";
import { localizePath } from "#/libs/i18n";
import { formatDate, formatList } from "#/libs/intl.ts";
import { parseEnvText } from "./env-text";
import {
	BuildSecretsField,
	GitBuildFields,
	GitRuntimeFields,
	GitSourceFields,
} from "./GitForms";
import { detectionReasonText } from "./labels";

const checkIcon = {
	ok: <CheckCircle2 size={16} color="var(--mantine-color-green-6)" />,
	warning: <CircleAlert size={16} color="var(--mantine-color-yellow-6)" />,
	error: <CircleX size={16} color="var(--mantine-color-red-6)" />,
};

/**
 * "From Git repository": repository (+ deploy key) and server → check and
 * builder detection → build → runtime and env → review (pre-flight) →
 * the first build-and-deploy job, opened with its live log.
 */
export const GitDeployWizard: React.FC<{
	template: TemplateSummary;
	onBack: () => void;
}> = ({ template, onBack }) => {
	const { i18n } = useLingui();
	const freeDomainProvider = useFreeDomainProvider();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: servers = [] } = useQuery(serversQueryOptions);
	const unreachable = useUnreachableServers();
	const readyServers = servers.filter(
		(server) => liveServerStatus(server, unreachable) === "ready",
	);

	const [step, setStep] = useState(0);
	const [serverId, setServerId] = useState<string | null>(null);
	const [source, setSource] = useState<GitSource>({
		repoUrl: "",
		branch: "main",
		subdir: "",
		submodules: false,
		auth: "none",
		credentialId: null,
		allowPrivateHost: false,
	});
	const [credential, setCredential] = useState<GitCredentialView | null>(null);
	const [inspection, setInspection] = useState<RepoInspection | null>(null);
	const [build, setBuild] = useState<BuildSettings>(() =>
		BuildSettingsSchema.parse({}),
	);
	const [secretsText, setSecretsText] = useState("");
	const [runtime, setRuntime] = useState<RuntimeSettings>({
		port: DEFAULT_APP_PORT,
		healthPath: "",
		volumes: [],
	});
	const [envText, setEnvText] = useState("");
	const [webhook, setWebhook] = useState(true);
	const [keepImages, setKeepImages] = useState<number | null>(null);
	const [name, setName] = useState("");
	const [domain, setDomain] = useState("");
	const [acknowledged, setAcknowledged] = useState(false);
	const [preflight, setPreflight] = useState<PreflightResult | null>(null);

	useEffect(() => {
		if (!serverId && readyServers.length === 1) setServerId(readyServers[0].id);
	}, [readyServers, serverId]);

	const inspect = useAppMutation({
		mutationFn: async () =>
			await inspectRepoFn({
				data: { serverId: serverId ?? "", source, build },
			}),
		onSuccess: (result) => {
			setInspection(result);
			// Defaults from the detection; the owner can still change them.
			setRuntime((current) => ({ ...current, port: result.detection.port }));
			if (!name) {
				const repo = source.repoUrl
					.replace(/\.git$/, "")
					.split(/[/:]/)
					.filter(Boolean)
					.at(-1);
				if (repo) setName(repo);
			}
		},
		field: "repository",
	});

	const env = parseEnvText(envText);
	const secrets = parseEnvText(secretsText);

	const runPreflight = useAppMutation({
		mutationFn: async () =>
			await preflightFn({
				data: {
					templateId: template.id,
					serverId: serverId ?? "",
					domain: domain || undefined,
				},
			}),
		onSuccess: setPreflight,
		field: "preflight",
	});

	const deploy = useAppMutation({
		mutationFn: async () =>
			await createAppFn({
				data: {
					templateId: template.id,
					serverId,
					name,
					domain: domain || undefined,
					inputs: {},
					git: {
						source,
						build,
						runtime,
						env: env.values,
						buildSecrets: secrets.values,
						webhook,
						keepImages,
					},
					acknowledged,
				},
			}),
		onSuccess: async ({ appId, deploymentId }) => {
			await queryClient.invalidateQueries({
				queryKey: appsQueryOptions.queryKey,
			});
			await navigate({
				to: localizePath(`/apps/${appId}`) as never,
				search: { tab: "deployments", job: deploymentId } as never,
			});
		},
		field: "deploy",
	});

	const sourceReady =
		!!serverId &&
		!!source.repoUrl.trim() &&
		!!source.branch.trim() &&
		(source.auth === "none" || !!source.credentialId);
	const builderChosen =
		build.builder !== "auto" || !!inspection?.detection.builder;
	const canNext = [
		sourceReady && !!inspection,
		builderChosen && secrets.invalid.length === 0,
		env.invalid.length === 0 && runtime.port > 0,
		!!name.trim() && !!preflight?.ok && (!template.advanced || acknowledged),
	][step];

	const next = () => {
		const target = step + 1;
		if (target === 3) {
			setPreflight(null);
			runPreflight.mutate();
		}
		setStep(target);
	};
	const server = servers.find((item) => item.id === serverId);
	const reviewError = deploy.fieldError() ?? runPreflight.fieldError();
	const effectiveBuilder =
		build.builder === "auto" ? inspection?.detection.builder : build.builder;

	return (
		<Stack gap="lg">
			<Stepper
				active={step}
				onStepClick={(index) => index < step && setStep(index)}
				size="sm"
				allowNextStepsSelect={false}
			>
				<Stepper.Step label={i18n._("Repository")}>
					<Stack mt="md" maw={760}>
						<Select
							label={i18n._("Server")}
							description={i18n._(
								"The code is cloned and built on this server.",
							)}
							placeholder={i18n._("Select a server")}
							data={readyServers.map((item) => ({
								value: item.id,
								label: `${item.name} (${item.host})`,
							}))}
							value={serverId}
							onChange={(value) => {
								setServerId(value);
								setInspection(null);
							}}
						/>
						<GitSourceFields
							value={source}
							onChange={(value) => {
								setSource(value);
								setInspection(null);
								inspect.clearFieldError();
							}}
							credential={credential}
							onCredential={setCredential}
						/>
						<Group>
							<Button
								variant="light"
								disabled={!sourceReady}
								loading={inspect.isPending}
								onClick={() => inspect.mutate()}
							>
								{i18n._("Check repository")}
							</Button>
							{inspect.isPending && (
								<Text size="sm" c="dimmed">
									{i18n._("Cloning the branch on the server…")}
								</Text>
							)}
						</Group>
						{inspect.fieldError() && (
							<Alert color="red" variant="light">
								{inspect.fieldError()}
							</Alert>
						)}
						{inspection && (
							<Card withBorder p="md">
								<KeyValueList
									items={[
										{
											label: i18n._("Latest commit"),
											value: (
												<Group gap="xs" wrap="nowrap">
													<Code>{inspection.commitSha.slice(0, 12)}</Code>
													<Text size="sm" truncate>
														{inspection.message}
													</Text>
												</Group>
											),
										},
										{
											label: i18n._("Author"),
											value: inspection.committedAt
												? `${inspection.author} · ${formatDate(i18n.locale, inspection.committedAt, { dateStyle: "medium", timeStyle: "short" })}`
												: inspection.author,
										},
										{
											label: i18n._("Detected builder"),
											value: inspection.detection.builder
												? `${i18n._(builders[inspection.detection.builder].label)} · ${detectionReasonText(i18n, inspection.detection.reason)}`
												: detectionReasonText(
														i18n,
														inspection.detection.reason,
													),
										},
									]}
								/>
							</Card>
						)}
					</Stack>
				</Stepper.Step>

				<Stepper.Step
					label={i18n._("Build")}
					description={
						effectiveBuilder
							? i18n._(builders[effectiveBuilder].label)
							: undefined
					}
				>
					<Stack mt="md" maw={760}>
						<GitBuildFields
							value={build}
							onChange={setBuild}
							detection={inspection?.detection ?? null}
							defaults={inspection?.defaults.limits ?? null}
							maxTimeoutSeconds={inspection?.defaults.maxTimeoutSeconds}
						/>
						<BuildSecretsField value={secretsText} onChange={setSecretsText} />
					</Stack>
				</Stepper.Step>

				<Stepper.Step label={i18n._("Runtime")}>
					<Stack mt="md" maw={760}>
						<GitRuntimeFields value={runtime} onChange={setRuntime} />
						<Textarea
							label={i18n._("Environment variables")}
							description={i18n._(
								"KEY=value per line, given to the running app. Editable later in the Environment tab.",
							)}
							autosize
							minRows={3}
							styles={{
								input: { fontFamily: "var(--mantine-font-family-monospace)" },
							}}
							value={envText}
							error={
								env.invalid.length
									? i18n._("Invalid names: {names}", {
											names: formatList(i18n.locale, env.invalid, "unit"),
										})
									: undefined
							}
							onChange={(event) => setEnvText(event.currentTarget.value)}
						/>
						<Group grow align="flex-start">
							<NumberInput
								label={i18n._("Images kept for rollback")}
								min={1}
								placeholder={
									inspection
										? String(inspection.defaults.keepImages)
										: undefined
								}
								value={keepImages ?? ""}
								onChange={(value) =>
									setKeepImages(typeof value === "number" ? value : null)
								}
							/>
							<Switch
								mt="lg"
								label={i18n._("Redeploy on push (webhook)")}
								description={i18n._(
									"The webhook URL and secret are shown in the app's Settings.",
								)}
								checked={webhook}
								onChange={(event) => setWebhook(event.currentTarget.checked)}
							/>
						</Group>
					</Stack>
				</Stepper.Step>

				<Stepper.Step label={i18n._("Review")}>
					<Stack mt="md" maw={760}>
						<TextInput
							label={i18n._("App name")}
							value={name}
							onChange={(event) => setName(event.currentTarget.value)}
						/>
						<TextInput
							label={i18n._("Domain")}
							placeholder={EXAMPLES.appHost}
							description={i18n._(
								"Leave empty for a free {provider} domain. Point an A record at the server first when using your own domain.",
								{ provider: freeDomainProvider },
							)}
							value={domain}
							onChange={(event) => setDomain(event.currentTarget.value)}
						/>
						<Card withBorder p="md">
							<KeyValueList
								items={[
									{
										label: i18n._("Repository"),
										value: `${source.repoUrl} · ${source.branch}${source.subdir ? ` · ${source.subdir}` : ""}`,
									},
									{
										label: i18n._("Builder"),
										value: effectiveBuilder
											? i18n._(builders[effectiveBuilder].label)
											: "—",
									},
									{
										label: i18n._("Port"),
										value: String(runtime.port),
									},
									{
										label: i18n._("Server"),
										value: server ? `${server.name} (${server.host})` : null,
									},
								]}
							/>
						</Card>
						<TemplateWarnings template={template} />
						{localizedTemplate(template, i18n).limitation && (
							<Alert
								color="orange"
								variant="light"
								title={i18n._("Limitation")}
							>
								{localizedTemplate(template, i18n).limitation}
							</Alert>
						)}
						{template.advanced && (
							<Checkbox
								label={i18n._("I understand the warnings above")}
								checked={acknowledged}
								onChange={(event) =>
									setAcknowledged(event.currentTarget.checked)
								}
							/>
						)}
						<Card withBorder p="md">
							<Group justify="space-between" mb="sm">
								<Text fw={600}>{i18n._("Pre-flight checks")}</Text>
								<Button
									size="xs"
									variant="subtle"
									loading={runPreflight.isPending}
									onClick={() => runPreflight.mutate()}
								>
									{i18n._("Run again")}
								</Button>
							</Group>
							{runPreflight.isPending && !preflight ? (
								<Loader size="sm" />
							) : (
								<Stack gap="xs">
									{preflight?.checks.map((check) => (
										<Group
											key={check.id}
											gap="sm"
											wrap="nowrap"
											align="flex-start"
										>
											{checkIcon[check.status]}
											<div>
												<Text size="sm" fw={500}>
													{i18n._(preflightLabels[check.id])}
												</Text>
												<Text size="xs" c="dimmed">
													{renderCheckDetail(i18n, check.message)}
												</Text>
											</div>
										</Group>
									))}
								</Stack>
							)}
						</Card>
						{reviewError && (
							<Alert
								color="red"
								variant="light"
								icon={<CircleX size={16} />}
								title={i18n._("Could not deploy")}
							>
								{reviewError}
							</Alert>
						)}
					</Stack>
				</Stepper.Step>
			</Stepper>
			<Group justify="space-between">
				<Button
					variant="default"
					onClick={() => (step === 0 ? onBack() : setStep(step - 1))}
				>
					{i18n._("Back")}
				</Button>
				{step < 3 ? (
					<Button disabled={!canNext} onClick={next}>
						{i18n._("Next")}
					</Button>
				) : (
					<Button
						disabled={!canNext}
						loading={deploy.isPending}
						onClick={() => deploy.mutate()}
					>
						{i18n._("Build and deploy")}
					</Button>
				)}
			</Group>
		</Stack>
	);
};
