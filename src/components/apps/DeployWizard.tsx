import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Alert,
	Anchor,
	Avatar,
	Button,
	Card,
	Checkbox,
	Divider,
	Group,
	Loader,
	Radio,
	Select,
	SimpleGrid,
	Stack,
	Stepper,
	Switch,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	CheckCircle2,
	CircleAlert,
	CircleX,
	Search,
	Wand2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	CustomComposeForm,
	type CustomComposeValue,
	customComposeReady,
	emptyCustomCompose,
} from "#/components/apps/CustomComposeForm";
import { useFreeDomainProvider } from "#/components/apps/useFreeDomainProvider";
import { GitDeployWizard } from "#/components/git/GitDeployWizard";
import {
	liveServerStatus,
	useUnreachableServers,
} from "#/components/monitoring/ServerLiveStatus";
import { useCan } from "#/components/teams/useCan";
import {
	localizedInput,
	localizedTemplate,
} from "#/components/templates/localized.ts";
import {
	TemplateBadges,
	TemplateWarnings,
} from "#/components/templates/TemplateMeta";
import { KeyValueList } from "#/components/ui/KeyValueList";
import { SecretInput } from "#/components/ui/SecretInput.tsx";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	type AppSourceDefinition,
	appSourceKinds,
	appSources,
} from "#/config/app-sources.ts";
import { renderCheckDetail } from "#/config/check-details.ts";
import { type Permission, permissions } from "#/config/permissions.ts";
import { preflightLabels } from "#/config/preflight.ts";
import { EXAMPLES } from "#/config/shared.ts";
import { serverStatusMeta } from "#/config/status.ts";
import { createAppFn, preflightFn } from "#/features/apps/apps.functions.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import type { PreflightResult } from "#/features/apps/schema.ts";
import { userQueryOptions } from "#/features/auth/auth.query.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import type { CustomComposeAnalysis } from "#/features/templates/schema.ts";
import {
	type TemplateInput,
	type TemplateSummary,
	validateVariableValue,
} from "#/features/templates/schema.ts";
import {
	templatesQueryOptions,
	templateVersionsQueryOptions,
} from "#/features/templates/templates.query.ts";
import { errorText } from "#/libs/coded.ts";
import { LocalizedLink, localizePath } from "#/libs/i18n";
import { formatBytes, formatDate, formatList } from "#/libs/intl.ts";
import { isAppErrorMessage } from "#/utils/error.ts";

const STEPS = 5;

const checkIcon = {
	ok: <CheckCircle2 size={16} color="var(--mantine-color-green-6)" />,
	warning: <CircleAlert size={16} color="var(--mantine-color-yellow-6)" />,
	error: <CircleX size={16} color="var(--mantine-color-red-6)" />,
};

/** Template → Version → Server → Domain & env → Review (pre-flight) → Deploy. */
export const DeployWizard: React.FC<{ initialTemplateId?: string }> = ({
	initialTemplateId,
}) => {
	const { i18n } = useLingui();
	const can = useCan();
	const freeDomainProvider = useFreeDomainProvider();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: templates = [] } = useQuery(templatesQueryOptions);
	const { data: servers = [] } = useQuery(serversQueryOptions);

	const [step, setStep] = useState(initialTemplateId ? 1 : 0);
	const [search, setSearch] = useState("");
	const [templateId, setTemplateId] = useState<string | null>(
		initialTemplateId ?? null,
	);
	const [includePrereleases, setIncludePrereleases] = useState(false);
	const [version, setVersion] = useState<string | null>(null);
	const [serverId, setServerId] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [domain, setDomain] = useState("");
	const [inputs, setInputs] = useState<Record<string, string>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [preflight, setPreflight] = useState<PreflightResult | null>(null);
	const [custom, setCustom] = useState<CustomComposeValue>(emptyCustomCompose);
	const [analysis, setAnalysis] = useState<CustomComposeAnalysis | null>(null);
	const [acknowledged, setAcknowledged] = useState(false);

	const template = templates.find((item) => item.id === templateId) ?? null;
	const inline = template?.versionSource === "inline";
	const needsAck =
		!!template && (template.advanced || template.security.allows.length > 0);
	const versions = useQuery({
		...templateVersionsQueryOptions(templateId ?? "", includePrereleases),
		enabled: !!templateId && !inline,
	});
	const unreachable = useUnreachableServers();
	const readyServers = servers.filter(
		(server) => liveServerStatus(server, unreachable) === "ready",
	);

	const { data: account } = useQuery(userQueryOptions);
	// Prefill (template `prefill`): e.g. the admin email = the account email.
	useEffect(() => {
		if (!template || !account) return;
		const prefilled = template.inputs.filter(
			(input) => input.prefill === "account_email" && !(input.name in inputs),
		);
		if (prefilled.length === 0) return;
		setInputs((prev) => ({
			...Object.fromEntries(
				prefilled.map((input) => [input.name, account.email]),
			),
			...prev,
		}));
	}, [template, account, inputs]);

	const { data: existingApps = [] } = useQuery(appsQueryOptions);
	/** "PocketBase", then "PocketBase 2", "PocketBase 3", … */
	const defaultName = (base: string) => {
		const taken = new Set(existingApps.map((app) => app.name));
		if (!taken.has(base)) return base;
		let index = 2;
		while (taken.has(`${base} ${index}`)) index++;
		return `${base} ${index}`;
	};
	useEffect(() => {
		if (template && !name)
			setName(defaultName(localizedTemplate(template, i18n).name));
	});
	useEffect(() => {
		if (!serverId && readyServers.length === 1) setServerId(readyServers[0].id);
	}, [readyServers, serverId]);

	// Cheap filter over a handful of templates; recomputed on every render so
	// it follows locale changes (the i18n instance itself is stable).
	const query = search.trim().toLowerCase();
	const filtered = templates.filter((item) => {
		const texts = localizedTemplate(item, i18n);
		// Kinds with their own page (databases) are offered as a card above.
		if ((appSources[item.sourceKind] as AppSourceDefinition).section) {
			return false;
		}
		return (
			!query ||
			[item.name, texts.name, texts.description, item.category, ...item.tags]
				.join(" ")
				.toLowerCase()
				.includes(query)
		);
	});

	// Failures show inline on the review step (not a toast that is easy to
	// miss while the wizard waits).
	const runPreflight = useAppMutation({
		mutationFn: async () =>
			await preflightFn({
				data: {
					templateId: templateId ?? "",
					serverId: serverId ?? "",
					domain: domain || undefined,
					// The server dry-renders these: a version the policy
					// refuses shows here, not after Deploy.
					version: version ?? undefined,
					name: name || undefined,
					inputs: Object.fromEntries(
						Object.entries(inputs).filter(([, value]) => value !== ""),
					),
				},
			}),
		onSuccess: setPreflight,
		field: "preflight",
	});

	const deploy = useAppMutation({
		mutationFn: async () =>
			await createAppFn({
				data: {
					templateId,
					serverId,
					name,
					version: version ?? undefined,
					domain: domain || undefined,
					inputs: Object.fromEntries(
						Object.entries(inputs).filter(([, value]) => value !== ""),
					),
					custom: inline ? custom : undefined,
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
	const reviewError = deploy.fieldError() ?? runPreflight.fieldError();
	// Version listing / template fetch problems are fixed with a GitHub token.
	const githubProblem =
		!!reviewError &&
		isAppErrorMessage(i18n, reviewError, [
			"GITHUB_RATE_LIMITED",
			"TEMPLATE_SOURCE_ERROR",
		]);

	const validateEnvStep = (current: TemplateSummary): boolean => {
		const next: Record<string, string> = {};
		if (!name.trim()) next.name = i18n._("App name is required");
		for (const input of current.inputs) {
			const value = inputs[input.name] ?? "";
			if (!value) continue;
			const error = validateVariableValue(
				localizedInput(input, i18n).label,
				{
					value: "",
					secret: input.secret,
					credential: false,
					editable: true,
					type: input.type,
					min_length: input.minLength,
				},
				value,
			);
			if (error) next[input.name] = errorText(i18n, error);
		}
		setErrors(next);
		return Object.keys(next).length === 0;
	};

	const canNext = [
		!!template,
		inline ? customComposeReady(custom, analysis) : !!template,
		!!serverId,
		true,
		!!preflight?.ok && (!needsAck || acknowledged),
	][step];

	const next = () => {
		if (step === 3 && template && !validateEnvStep(template)) return;
		const target = Math.min(step + 1, STEPS - 1);
		if (target === 4) {
			setPreflight(null);
			runPreflight.mutate();
		}
		setStep(target);
	};

	const pick = (item: TemplateSummary) => {
		setTemplateId(item.id);
		setVersion(null);
		setInputs({});
		setCustom(emptyCustomCompose());
		setAnalysis(null);
		setAcknowledged(false);
		setName(defaultName(localizedTemplate(item, i18n).name));
		setStep(1);
	};
	const server = servers.find((item) => item.id === serverId);

	// Git apps have their own flow (repository → build → runtime → review).
	if (template?.sourceKind === "git" && step > 0) {
		return (
			<GitDeployWizard
				template={template}
				onBack={() => {
					setStep(0);
					setTemplateId(null);
				}}
			/>
		);
	}

	return (
		<Stack gap="lg">
			<Stepper
				active={step}
				onStepClick={(index) => index < step && setStep(index)}
				size="sm"
				allowNextStepsSelect={false}
			>
				<Stepper.Step
					label={i18n._("Template")}
					description={
						template ? localizedTemplate(template, i18n).name : undefined
					}
				>
					<Stack mt="md">
						<SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
							{appSourceKinds.map((kind) => {
								const ownTemplate = templates.find(
									(item) => item.sourceKind === kind && kind !== "template",
								);
								const section = (appSources[kind] as AppSourceDefinition)
									.section;
								if (section) {
									// Created on its own page (e.g. databases).
									return (
										<Card
											key={kind}
											withBorder
											p="sm"
											component={LocalizedLink}
											to={section.create}
											style={{ cursor: "pointer" }}
										>
											<Text fw={600} size="sm">
												{i18n._(appSources[kind].label)}
											</Text>
											<Text size="xs" c="dimmed">
												{i18n._(appSources[kind].description)}
											</Text>
										</Card>
									);
								}
								return (
									<Card
										key={kind}
										withBorder
										p="sm"
										style={{
											cursor: ownTemplate ? "pointer" : undefined,
											borderColor:
												(template?.sourceKind ?? "template") === kind
													? "var(--accent-border)"
													: undefined,
										}}
										onClick={() => ownTemplate && pick(ownTemplate)}
									>
										<Text fw={600} size="sm">
											{i18n._(appSources[kind].label)}
										</Text>
										<Text size="xs" c="dimmed">
											{i18n._(appSources[kind].description)}
										</Text>
									</Card>
								);
							})}
						</SimpleGrid>
						<TextInput
							leftSection={<Search size={16} />}
							placeholder={i18n._("Search templates")}
							value={search}
							onChange={(event) => setSearch(event.currentTarget.value)}
						/>
						<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
							{filtered.map((item) => (
								<Card
									key={item.id}
									withBorder
									p="md"
									style={{
										cursor: "pointer",
										borderColor:
											item.id === templateId
												? "var(--accent-border)"
												: undefined,
									}}
									onClick={() => pick(item)}
								>
									<Group gap="sm" wrap="nowrap" mb="xs">
										<Avatar
											src={
												item.hasLogo
													? `/api/templates/${item.id}/logo`
													: undefined
											}
											radius="md"
										>
											{item.name.slice(0, 2)}
										</Avatar>
										<div>
											<Text fw={600}>{localizedTemplate(item, i18n).name}</Text>
											<TemplateBadges template={item} />
										</div>
									</Group>
									<Text size="sm" c="dimmed" lineClamp={3}>
										{localizedTemplate(item, i18n).description}
									</Text>
								</Card>
							))}
						</SimpleGrid>
					</Stack>
				</Stepper.Step>

				<Stepper.Step
					label={inline ? i18n._("Compose") : i18n._("Version")}
					description={
						inline
							? undefined
							: (version ?? versions.data?.defaultRef ?? undefined)
					}
				>
					{inline && templateId ? (
						<Stack mt="md" maw={860}>
							<CustomComposeForm
								templateId={templateId}
								value={custom}
								onChange={setCustom}
								analysis={analysis}
								onAnalysis={setAnalysis}
							/>
						</Stack>
					) : (
						<Stack mt="md" maw={520}>
							{versions.isLoading ? (
								<Loader size="sm" />
							) : versions.error ? (
								<Alert color="red">{versions.error.message}</Alert>
							) : (
								<Select
									label={i18n._("Version")}
									placeholder={
										versions.data?.defaultRef
											? i18n._("Latest stable ({version})", {
													version: versions.data.defaultRef,
												})
											: i18n._("Latest stable")
									}
									data={(versions.data?.versions ?? []).map((item) => ({
										value: item.ref,
										label: `${item.name}${item.prerelease ? " (pre-release)" : ""}${
											item.publishedAt
												? ` · ${formatDate(i18n.locale, item.publishedAt, { dateStyle: "medium" })}`
												: ""
										}`,
									}))}
									value={version}
									onChange={setVersion}
									searchable
									clearable
								/>
							)}
							<Switch
								label={i18n._("Show pre-releases")}
								checked={includePrereleases}
								onChange={(event) =>
									setIncludePrereleases(event.currentTarget.checked)
								}
							/>
						</Stack>
					)}
				</Stepper.Step>

				<Stepper.Step label={i18n._("Server")} description={server?.name}>
					<Stack mt="md">
						{readyServers.length === 0 && (
							<Alert color="yellow">
								{i18n._(
									"No bootstrapped server yet. Bootstrap a server before deploying apps.",
								)}
							</Alert>
						)}
						<Radio.Group value={serverId} onChange={setServerId}>
							<SimpleGrid cols={{ base: 1, sm: 2 }}>
								{servers.map((item) => {
									const ready = liveServerStatus(item, unreachable) === "ready";
									return (
										<Radio.Card
											key={item.id}
											value={item.id}
											disabled={!ready}
											p="md"
											radius="md"
											style={{ opacity: ready ? 1 : 0.55 }}
										>
											<Group justify="space-between" wrap="nowrap">
												<Group gap="sm" wrap="nowrap">
													<Radio.Indicator disabled={!ready} />
													<div>
														<Text fw={600}>{item.name}</Text>
														<Text size="xs" c="dimmed">
															{item.host}
														</Text>
													</div>
												</Group>
												<StatusBadge meta={serverStatusMeta(item)} />
											</Group>
										</Radio.Card>
									);
								})}
							</SimpleGrid>
						</Radio.Group>
					</Stack>
				</Stepper.Step>

				<Stepper.Step label={i18n._("Domain & env")}>
					<Stack mt="md" maw={560}>
						<TextInput
							label={i18n._("App name")}
							value={name}
							error={errors.name}
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
						{groupInputs(template?.inputs ?? [], i18n).map((group) => (
							<Stack key={group.title ?? ""} gap="sm">
								{group.title && (
									<Divider label={group.title} labelPosition="left" mt="xs" />
								)}
								{group.inputs.map(({ input, texts }) => {
									if (input.type === "boolean") {
										const value =
											inputs[input.name] ?? input.placeholder ?? "false";
										return (
											<Switch
												key={input.name}
												label={texts.label}
												description={texts.description}
												checked={value === "true"}
												disabled={!!input.permission && !can(input.permission)}
												onChange={(event) => {
													const checked = event.currentTarget.checked;
													setInputs((prev) => ({
														...prev,
														[input.name]: String(checked),
													}));
												}}
											/>
										);
									}
									const Input = input.secret ? SecretInput : TextInput;
									const canGenerate = input.secret && input.generated;
									// Values that load code (template `permission`).
									const locked = !!input.permission && !can(input.permission);
									return (
										<Input
											key={input.name}
											label={texts.label}
											disabled={locked}
											description={
												locked ? (
													<>
														{texts.description}{" "}
														{i18n._(
															"Setting this needs the permission: {permission}.",
															{
																permission: i18n._(
																	permissions[input.permission as Permission]
																		.label,
																),
															},
														)}
													</>
												) : canGenerate ? (
													<>
														{texts.description}{" "}
														{i18n._(
															"Leave it empty and a strong password is generated on deploy; it is shown in the app's Credentials either way.",
														)}
													</>
												) : (
													texts.description
												)
											}
											leftSection={
												canGenerate ? (
													<Tooltip label={i18n._("Generate a password")}>
														<ActionIcon
															variant="subtle"
															size="sm"
															aria-label={i18n._("Generate a password")}
															onClick={() => {
																const value = randomPassword(
																	Math.max(input.minLength ?? 0, 24),
																);
																setInputs((prev) => ({
																	...prev,
																	[input.name]: value,
																}));
															}}
														>
															<Wand2 size={14} />
														</ActionIcon>
													</Tooltip>
												) : undefined
											}
											leftSectionPointerEvents="all"
											// Template values (e.g. a dashboard user name next to
											// its password), never the panel's sign-in; secrets
											// get theirs from SecretInput.
											autoComplete="off"
											placeholder={
												input.generated
													? i18n._("Leave empty to generate")
													: input.placeholder
											}
											value={inputs[input.name] ?? ""}
											error={errors[input.name]}
											onChange={(event) => {
												// Read now: currentTarget is null when the updater runs.
												const value = event.currentTarget.value;
												setInputs((prev) => ({ ...prev, [input.name]: value }));
											}}
										/>
									);
								})}
							</Stack>
						))}
						<Text size="xs" c="dimmed">
							{i18n._(
								"Secrets are generated automatically and shown later in the app's credentials panel.",
							)}
						</Text>
					</Stack>
				</Stepper.Step>

				<Stepper.Step label={i18n._("Review")}>
					<Stack mt="md">
						<Card withBorder p="md">
							<KeyValueList
								items={[
									{
										label: i18n._("Template"),
										value: template
											? localizedTemplate(template, i18n).name
											: null,
									},
									inline
										? {
												label: i18n._("Routed service"),
												value: formatList(
													i18n.locale,
													custom.routes.map(
														(route) => `${route.service}:${route.port}`,
													),
													"unit",
												),
											}
										: {
												label: i18n._("Version"),
												value:
													version ??
													versions.data?.defaultRef ??
													i18n._("Latest stable"),
											},
									{
										label: i18n._("Server"),
										value: server ? `${server.name} (${server.host})` : null,
									},
									{ label: i18n._("App name"), value: name },
									{
										label: i18n._("Domain"),
										value:
											domain ||
											i18n._("Free {provider} domain", {
												provider: freeDomainProvider,
											}),
									},
									...(template?.inputs ?? [])
										.filter(
											(input) =>
												input.generated ||
												input.prefill ||
												(inputs[input.name] ?? "") !== "",
										)
										.filter((input) => input.type !== "boolean")
										.map((input) => {
											const value = inputs[input.name] ?? "";
											return {
												label: localizedInput(input, i18n).label,
												value: !value
													? i18n._("Generated on deploy (see Credentials)")
													: input.secret
														? i18n._("Set by you (hidden)")
														: value,
											};
										}),
									{
										label: i18n._("Requirements"),
										value: template
											? i18n._("{memory} RAM, {disk} disk", {
													memory: formatBytes(
														i18n.locale,
														template.requirements.memoryMb * 1024 * 1024,
													),
													disk: formatBytes(
														i18n.locale,
														template.requirements.diskMb * 1024 * 1024,
													),
												})
											: null,
									},
								]}
							/>
						</Card>
						{template && <TemplateWarnings template={template} />}
						{template && localizedTemplate(template, i18n).limitation && (
							<Alert
								color="orange"
								variant="light"
								title={i18n._("Limitation")}
							>
								{localizedTemplate(template, i18n).limitation}
							</Alert>
						)}
						{template && localizedTemplate(template, i18n).notes && (
							<Alert
								color="blue"
								variant="light"
								title={i18n._("After deploying")}
							>
								{localizedTemplate(template, i18n).notes}
							</Alert>
						)}
						{needsAck && (
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
								<Stack gap="xs">
									<Text size="sm">{reviewError}</Text>
									{githubProblem && (
										<Anchor
											size="sm"
											component={LocalizedLink}
											to="/settings/github"
										>
											{i18n._("Set a GitHub token in Settings")}
										</Anchor>
									)}
								</Stack>
							</Alert>
						)}
					</Stack>
				</Stepper.Step>
			</Stepper>

			<Group justify="space-between">
				<Button
					variant="default"
					disabled={step === 0}
					onClick={() => setStep((current) => Math.max(0, current - 1))}
				>
					{i18n._("Back")}
				</Button>
				{step < STEPS - 1 ? (
					<Button disabled={!canNext} onClick={next}>
						{i18n._("Next")}
					</Button>
				) : (
					<Button
						disabled={!canNext}
						loading={deploy.isPending}
						onClick={() => deploy.mutate()}
					>
						{i18n._("Deploy")}
					</Button>
				)}
			</Group>
		</Stack>
	);
};

const PASSWORD_ALPHABET =
	"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Random password from the browser's CSPRNG (unbiased rejection sampling). */
function randomPassword(length: number): string {
	const out: string[] = [];
	const limit = 256 - (256 % PASSWORD_ALPHABET.length);
	while (out.length < length) {
		const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
		for (const byte of bytes) {
			if (byte < limit && out.length < length) {
				out.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
			}
		}
	}
	return out.join("");
}

/** Inputs in template order, grouped by their (localized) section. */
function groupInputs(inputs: TemplateInput[], i18n: I18n) {
	const groups: {
		title?: string;
		inputs: {
			input: TemplateInput;
			texts: ReturnType<typeof localizedInput>;
		}[];
	}[] = [];
	for (const input of inputs) {
		const texts = localizedInput(input, i18n);
		let group = groups.find((item) => item.title === texts.group);
		if (!group) {
			group = { title: texts.group, inputs: [] };
			groups.push(group);
		}
		group.inputs.push({ input, texts });
	}
	return groups;
}
