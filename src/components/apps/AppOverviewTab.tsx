import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Card,
	Code,
	Group,
	SimpleGrid,
	Stack,
	Table,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation } from "@tanstack/react-query";
import {
	Check,
	Copy,
	ExternalLink,
	Eye,
	Play,
	RefreshCw,
	RotateCw,
	Square,
} from "lucide-react";
import { useState } from "react";
import { AppDatabaseLinksCard } from "#/components/databases/AppDatabaseLinksCard";
import { useCan } from "#/components/teams/useCan";
import { CopyButton } from "#/components/ui/CopyIconButton";
import { ErrorText } from "#/components/ui/ErrorText.tsx";
import { notifications } from "#/components/ui/Notifications";
import { appStatuses, isBusy } from "#/config/status.ts";
import {
	appActionFn,
	rerunRotateHookFn,
	revealCredentialFn,
	rotateVariableFn,
} from "#/features/apps/apps.functions.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import { errorInfo } from "#/libs/coded.ts";
import type { ErrorCode } from "#/libs/error-codes.ts";
import { translateTemplateText } from "#/libs/i18n.ts";
import { formatList } from "#/libs/intl.ts";
import { AppJobDrawer } from "./AppJobDrawer";
import { AppStatusStrip } from "./AppStatusStrip";
import { AppUpdatesCard } from "./AppUpdatesCard";
import { RotateHookCheckbox } from "./RotateHookCheckbox";
import { useAppJob } from "./useAppJob";

/** Errors of a readiness wait that may have recovered since (BUG-011). */
const READINESS_ERRORS: ReadonlySet<string> = new Set<ErrorCode>([
	"APP_UNHEALTHY",
	"APP_READY_TIMEOUT",
	"APP_NOT_READY_HINT",
]);

export const AppOverviewTab: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { i18n } = useLingui();
	const can = useCan();
	const { app } = overview;
	const jobs = useAppJob(app.id);
	const [revealed, setRevealed] = useState<Record<string, string>>({});
	const deployed = overview.services.length > 0;
	const busy = jobs.isStarting || isBusy(appStatuses, app.status);
	// Running, but some services are not (e.g. left exited by a reboot of
	// the host): Start brings them back; a service without a container
	// needs a redeploy (BUG-015).
	const live = !!appStatuses[app.status]?.live;
	const notRunning = live ? (overview.usage?.notRunning ?? []) : [];
	const missing = live ? (overview.usage?.missing ?? []) : [];
	const redeploy = () => action("redeploy", i18n._("Redeploy app"));

	const reveal = useMutation({
		mutationFn: async (name: string) => ({
			name,
			value: await revealCredentialFn({ data: { appId: app.id, name } }),
		}),
		onSuccess: ({ name, value }) =>
			setRevealed((prev) => ({ ...prev, [name]: value })),
		onError: (error: Error) => notifications.error({ message: error.message }),
	});

	const confirmReveal = (name: string) =>
		modals.openConfirmModal({
			title: i18n._("Reveal secret"),
			children: (
				<Text size="sm">
					{i18n._(
						"{name} will be shown in plain text and the reveal is recorded in the audit log.",
						{
							name,
						},
					)}
				</Text>
			),
			labels: { confirm: i18n._("Reveal"), cancel: i18n._("Cancel") },
			onConfirm: () => reveal.mutate(name),
		});

	const confirmRotate = (name: string) => {
		const hook =
			overview.credentials.find((item) => item.name === name)?.rotateHook ??
			null;
		let runRotateHook = hook?.default;
		modals.openConfirmModal({
			title: i18n._("Rotate {name}", { name }),
			centered: true,
			children: (
				<Stack gap="sm">
					<Text size="sm">
						{i18n._(
							"A new value is generated for {name} (and anything derived from it) and the app is redeployed. The old value stops working.",
							{ name },
						)}
					</Text>
					{hook && (
						<RotateHookCheckbox
							hook={hook}
							onChange={(checked) => {
								runRotateHook = checked;
							}}
						/>
					)}
				</Stack>
			),
			labels: { confirm: i18n._("Rotate"), cancel: i18n._("Cancel") },
			confirmProps: { color: "red" },
			onConfirm: () => {
				setRevealed((prev) => {
					const { [name]: _removed, ...rest } = prev;
					return rest;
				});
				jobs.startJob({
					title: i18n._("Rotate {name}", { name }),
					start: () =>
						rotateVariableFn({
							data: { appId: app.id, name, runRotateHook },
						}),
				});
			},
		});
	};

	const action = (
		kind: "redeploy" | "start" | "stop" | "restart",
		title: string,
	) =>
		jobs.startJob({
			title,
			start: () => appActionFn({ data: { appId: app.id, action: kind } }),
		});

	// The readiness wait failed, but monitoring has since seen every
	// container healthy: the deploy itself did not finish (redeploy).
	const recovered =
		app.status === "error" &&
		READINESS_ERRORS.has(app.lastErrorCode ?? "") &&
		!!overview.usage?.allHealthy &&
		new Date(overview.usage.at) > new Date(app.updatedAt);

	// Template texts arrive in English; translated via the catalogs.
	const notes = translateTemplateText(i18n, overview.notes) ?? null;
	const limitation = translateTemplateText(i18n, overview.limitation) ?? null;

	return (
		<Stack gap="md">
			{limitation && (
				<Alert color="orange" variant="light" title={i18n._("Limitation")}>
					{limitation}
				</Alert>
			)}
			{notes && (
				<Alert color="blue" variant="light" title={i18n._("After deploying")}>
					{notes}
				</Alert>
			)}
			{app.needsRedeploy && (
				<Alert color="yellow" title={i18n._("Redeploy needed")}>
					{i18n._(
						"Environment or domain changes take effect after a redeploy.",
					)}
				</Alert>
			)}
			{overview.networkFixPending && (
				<Alert
					color="yellow"
					title={i18n._("Redeploy to finish the network fix")}
				>
					{i18n._(
						"This app was deployed before its services were kept off the shared network under their service names. It runs, but its files on the server still use the old setup: redeploy it to finish the fix.",
					)}
				</Alert>
			)}
			{overview.rotateHooksFailed.map((failed) => (
				<Alert
					key={failed.name}
					color="orange"
					title={i18n._("{step} after rotating {name} did not complete", {
						step: translateTemplateText(i18n, failed.label),
						name: failed.name,
					})}
				>
					<Stack gap="xs" align="flex-start">
						<Text size="sm">
							{i18n._(
								"The rotation itself is done, but its follow-up step failed or could not run. The job log has the details.",
							)}
						</Text>
						{can("app.env.edit") && (
							<Button
								size="xs"
								variant="light"
								color="orange"
								leftSection={<RefreshCw size={14} />}
								disabled={busy}
								onClick={() =>
									jobs.startJob({
										title: i18n._(
											"Run the follow-up step of the {name} rotation again",
											{ name: failed.name },
										),
										start: () =>
											rerunRotateHookFn({
												data: { appId: app.id, name: failed.name },
											}),
									})
								}
							>
								{i18n._("Run it again")}
							</Button>
						)}
					</Stack>
				</Alert>
			))}
			{notRunning.length > 0 && (
				<Alert color="orange" title={i18n._("Some services are not running")}>
					{i18n._(
						"{services} stopped while the app should be running (for example after a reboot of the server). Start the app to bring them back.",
						{ services: formatList(i18n.locale, notRunning, "unit") },
					)}
				</Alert>
			)}
			{missing.length > 0 && (
				<Alert color="orange" title={i18n._("Some services have no container")}>
					<Stack gap="xs" align="flex-start">
						<Text size="sm">
							{i18n._(
								"{services} should be running but have no container (removed outside the panel?). Starting cannot create them: redeploy the app.",
								{ services: formatList(i18n.locale, missing, "unit") },
							)}
						</Text>
						{can("app.deploy") && (
							<Button
								size="xs"
								variant="light"
								color="orange"
								leftSection={<RefreshCw size={14} />}
								disabled={busy || overview.jobRunning}
								onClick={redeploy}
							>
								{i18n._("Redeploy")}
							</Button>
						)}
					</Stack>
				</Alert>
			)}
			{overview.restartPolicyPending.length > 0 && (
				<Alert
					color="yellow"
					title={i18n._("Redeploy to apply the restart policy")}
				>
					{i18n._(
						"{services} were deployed without a restart policy: after a reboot of the server they stay stopped. The next redeploy adds one.",
						{
							services: formatList(
								i18n.locale,
								overview.restartPolicyPending,
								"unit",
							),
						},
					)}
				</Alert>
			)}
			{app.lastError && app.status === "error" && (
				<Alert color="red" title={i18n._("Last error")}>
					<ErrorText
						error={errorInfo(
							app.lastError,
							app.lastErrorCode,
							app.lastErrorParams,
						)}
					/>
					{recovered && (
						<Text size="sm" mt="xs">
							{i18n._("Containers are healthy now — redeploy to finish.")}
						</Text>
					)}
				</Alert>
			)}
			<Card withBorder p="md">
				<Group gap="sm">
					{overview.links.map((link) => (
						<Button
							key={link.url}
							component="a"
							href={link.url}
							target="_blank"
							rel="noreferrer"
							variant={link.primary ? "filled" : "light"}
							leftSection={<ExternalLink size={16} />}
							disabled={!deployed}
						>
							{link.label
								? translateTemplateText(i18n, link.label)
								: i18n._("Open app")}
						</Button>
					))}
					{can("app.deploy") && (
						<>
							<Button
								variant="default"
								leftSection={<RefreshCw size={16} />}
								loading={jobs.isStarting}
								disabled={busy}
								onClick={redeploy}
							>
								{i18n._("Redeploy")}
							</Button>
							<Button
								variant="default"
								leftSection={<Play size={16} />}
								disabled={
									busy ||
									overview.jobRunning ||
									(app.status === "running" && notRunning.length === 0) ||
									!deployed
								}
								onClick={() => action("start", i18n._("Start"))}
							>
								{i18n._("Start")}
							</Button>
							<Button
								variant="default"
								leftSection={<RotateCw size={16} />}
								disabled={busy || app.status === "stopped" || !deployed}
								onClick={() => action("restart", i18n._("Restart"))}
							>
								{i18n._("Restart")}
							</Button>
							<Button
								variant="subtle"
								color="red"
								leftSection={<Square size={16} />}
								disabled={busy || app.status === "stopped" || !deployed}
								onClick={() => action("stop", i18n._("Stop"))}
							>
								{i18n._("Stop")}
							</Button>
						</>
					)}
				</Group>
			</Card>

			<AppStatusStrip overview={overview} />
			<AppUpdatesCard appId={app.id} appName={app.name} onJob={jobs.openJob} />

			<SimpleGrid cols={{ base: 1, md: 2 }}>
				<Card withBorder p="md">
					<Title order={5} mb="sm">
						{i18n._("Details")}
					</Title>
					<Table>
						<Table.Tbody>
							<Table.Tr>
								<Table.Td c="dimmed">{i18n._("Template")}</Table.Td>
								<Table.Td>
									{translateTemplateText(i18n, overview.templateName)}
								</Table.Td>
							</Table.Tr>
							<Table.Tr>
								<Table.Td c="dimmed">{i18n._("Version")}</Table.Td>
								<Table.Td>
									{overview.sourceKind === "git" ? "" : app.version}{" "}
									{app.commitSha && (
										<Code title={app.commitSha}>
											@{app.commitSha.slice(0, 12)}
										</Code>
									)}
								</Table.Td>
							</Table.Tr>
							<Table.Tr>
								<Table.Td c="dimmed">{i18n._("Folder")}</Table.Td>
								<Table.Td>
									<Code>{app.folder}</Code>
								</Table.Td>
							</Table.Tr>
							<Table.Tr>
								<Table.Td c="dimmed">{i18n._("Services")}</Table.Td>
								<Table.Td>
									{formatList(i18n.locale, overview.services, "unit")}
								</Table.Td>
							</Table.Tr>
						</Table.Tbody>
					</Table>
				</Card>
				{overview.hasCredentials && (
					<Card withBorder p="md">
						<Title order={5} mb="sm">
							{i18n._("Credentials")}
						</Title>
						{overview.app.envPendingAt && overview.credentials.length > 0 && (
							<Alert color="yellow" variant="light" mb="sm">
								{i18n._(
									"These values aren't live yet: the last deploy didn't finish. They become live when a deploy succeeds.",
								)}
							</Alert>
						)}
						{overview.credentials.length === 0 ? (
							<Text size="sm" c="dimmed">
								{i18n._("Available after the first deploy.")}
							</Text>
						) : (
							<Stack gap="xs">
								{overview.credentials.map((credential) => {
									const value = revealed[credential.name] ?? credential.value;
									const hidden =
										credential.secret && !(credential.name in revealed);
									return (
										<div key={credential.name}>
											<Group gap={6} wrap="nowrap" align="baseline">
												<Text size="sm" fw={500}>
													{translateTemplateText(
														i18n,
														credential.label ?? credential.description,
													) ?? credential.name}
												</Text>
												<Text size="xs" c="dimmed" ff="monospace">
													{credential.name}
												</Text>
												{credential.initial && (
													<Badge size="xs" variant="light" color="gray">
														{i18n._("Initial value")}
													</Badge>
												)}
											</Group>
											{credential.initial && (
												<Text size="xs" c="dimmed">
													{i18n._(
														"Set on the app's first start; it may have been changed in the app since.",
													)}
												</Text>
											)}
											<Group gap="xs" wrap="nowrap">
												<Code style={{ flex: 1, wordBreak: "break-all" }}>
													{value}
												</Code>
												{hidden ? (
													can("app.env.reveal") && (
														<Tooltip label={i18n._("Reveal")}>
															<ActionIcon
																variant="subtle"
																aria-label={i18n._("Reveal")}
																onClick={() => confirmReveal(credential.name)}
															>
																<Eye size={14} />
															</ActionIcon>
														</Tooltip>
													)
												) : (
													<CopyButton value={value}>
														{({ copied, copy }) => (
															<ActionIcon
																variant="subtle"
																aria-label={i18n._("Copy")}
																onClick={copy}
															>
																{copied ? (
																	<Check size={14} />
																) : (
																	<Copy size={14} />
																)}
															</ActionIcon>
														)}
													</CopyButton>
												)}
												{credential.rotatable && can("app.env.edit") && (
													<Tooltip label={i18n._("Rotate")}>
														<ActionIcon
															variant="subtle"
															color="red"
															aria-label={i18n._("Rotate")}
															disabled={busy}
															onClick={() => confirmRotate(credential.name)}
														>
															<RefreshCw size={14} />
														</ActionIcon>
													</Tooltip>
												)}
											</Group>
										</div>
									);
								})}
							</Stack>
						)}
					</Card>
				)}
			</SimpleGrid>
			<AppDatabaseLinksCard overview={overview} jobs={jobs} />
			<AppJobDrawer
				job={jobs.job}
				appName={app.name}
				onClose={jobs.closeJob}
				onCompleted={() => jobs.refresh()}
			/>
		</Stack>
	);
};
