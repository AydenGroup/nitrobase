import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
	Alert,
	Anchor,
	Badge,
	Button,
	Checkbox,
	Code,
	Group,
	Modal,
	Select,
	Stack,
	Text,
} from "@mantine/core";
import { useMounted } from "@mantine/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ActionLogDrawer } from "#/components/servers/ActionLogDrawer";
import { KeyValueList } from "#/components/ui/KeyValueList";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { APP_NAME, VERSION_ENV_NAME } from "#/config/shared.ts";
import { destinationsQueryOptions } from "#/features/backups/backups.query.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import type {
	UpgradeBlocker,
	UpgradeOutcome,
} from "#/features/upgrade/schema.ts";
import {
	getUpgradeOverviewFn,
	startPanelUpgradeFn,
} from "#/features/upgrade/upgrade.functions.ts";
import { upgradeOverviewQueryOptions } from "#/features/upgrade/upgrade.query.ts";
import { branded } from "#/libs/brand.ts";
import { errorText } from "#/libs/coded.ts";
import { formatDate } from "#/libs/intl.ts";

const blockerLabels = {
	not_container: branded(
		msg({
			id: "{appName} is not running in its production container here (development mode), so it cannot replace itself. Upgrade by pulling the new code.",
		}),
	),
	not_found: msg({
		id: "The panel container was not found on this host (PANEL_CONTAINER).",
	}),
	not_this_container: msg({
		id: "The container named PANEL_CONTAINER is not this panel.",
	}),
	not_compose: msg({
		id: "This panel was not started with docker compose; use the installer's layout to upgrade from here.",
	}),
	image_unpinned: msg({
		id: "The panel image has no version tag (built from source or 'latest'). Install a release image to upgrade from here.",
	}),
	no_healthcheck: msg({
		id: "The panel image has no health check, so a broken version could not be told apart. Re-run the installer once.",
	}),
	env_missing: {
		...msg({
			id: "The image tag in the install's .env ({variables}) does not match the running image. Re-run the installer once.",
		}),
		values: { variables: VERSION_ENV_NAME },
	},
	paused: msg({
		id: "This installation is paused (moved database). Resume it first.",
	}),
	upgrading: msg({ id: "An upgrade is running." }),
	no_update: branded(msg({ id: "{appName} is up to date." })),
} satisfies Record<UpgradeBlocker, MessageDescriptor>;

const outcomeLabels = {
	succeeded: msg({ id: "Upgraded" }),
	rolled_back: msg({ id: "Rolled back" }),
	failed: msg({ id: "Failed" }),
} satisfies Record<UpgradeOutcome, MessageDescriptor>;

const outcomeColors: Record<UpgradeOutcome, string> = {
	succeeded: "green",
	rolled_back: "orange",
	failed: "red",
};

/** Settings → Instance: version, release check and the in-panel upgrade. */
export const UpgradeCard: React.FC = () => {
	const { i18n } = useLingui();
	const mounted = useMounted();
	const queryClient = useQueryClient();
	const { data, isFetching } = useQuery(upgradeOverviewQueryOptions);
	const destinations = useQuery(destinationsQueryOptions);
	const { data: servers = [] } = useQuery(serversQueryOptions);
	const ready = servers.filter((server) => server.status === "ready");
	const [opened, setOpened] = useState(false);
	const [destinationId, setDestinationId] = useState<string | null>(null);
	const [serverId, setServerId] = useState<string | null>(null);
	const [understood, setUnderstood] = useState(false);
	const [job, setJob] = useState<string | null>(null);

	const refresh = useAppMutation({
		mutationFn: async () =>
			await getUpgradeOverviewFn({ data: { refresh: true } }),
		onSuccess: (overview) =>
			queryClient.setQueryData(upgradeOverviewQueryOptions.queryKey, overview),
	});
	const start = useAppMutation({
		mutationFn: async () =>
			await startPanelUpgradeFn({
				data: {
					version: data?.update.latest?.version ?? "",
					destinationId: destinationId ?? destinations.data?.[0]?.id ?? "",
					serverId: serverId ?? ready[0]?.id,
				},
			}),
		field: "upgrade",
		onSuccess: ({ deploymentId }) => {
			setOpened(false);
			setJob(deploymentId);
		},
	});

	if (!data) return null;
	const { update, blocker, last } = data;
	const latest = update.latest;
	const chosenDestination = destinationId ?? destinations.data?.[0]?.id ?? null;

	return (
		<SectionCard
			title={i18n._("{appName} version", { appName: APP_NAME })}
			description={i18n._(
				"New releases are checked on a schedule. Upgrading takes a {appName} backup first, then swaps the panel container and rolls back to this version if the new one does not become healthy.",
				{ appName: APP_NAME },
			)}
			actions={
				<Group gap="xs">
					<Button
						size="xs"
						variant="default"
						leftSection={<RefreshCw size={14} />}
						loading={refresh.isPending || isFetching}
						disabled={update.check === "disabled"}
						onClick={() => refresh.mutate()}
					>
						{i18n._("Check now")}
					</Button>
					<Button
						size="xs"
						leftSection={<ArrowUpCircle size={14} />}
						disabled={blocker !== null}
						onClick={() => setOpened(true)}
					>
						{latest
							? i18n._("Upgrade to {version}", { version: latest.version })
							: i18n._("Upgrade")}
					</Button>
				</Group>
			}
		>
			<Stack gap="sm">
				<KeyValueList
					items={[
						{ label: i18n._("Running"), value: <Code>{update.current}</Code> },
						{
							label: i18n._("Latest release"),
							value: latest ? (
								<Group gap="xs">
									<Code>{latest.version}</Code>
									{update.available && (
										<Badge color="brand" variant="light" size="sm">
											{i18n._("Update available")}
										</Badge>
									)}
									{latest.url && (
										<Anchor
											href={latest.url}
											target="_blank"
											rel="noreferrer"
											size="sm"
										>
											{i18n._("Release notes")}
										</Anchor>
									)}
								</Group>
							) : (
								"—"
							),
						},
						{
							label: i18n._("Channel"),
							value:
								update.channel === "stable"
									? i18n._("Stable releases")
									: i18n._("Stable and pre-releases"),
						},
						...(data.install
							? [
									{
										label: i18n._("Installed in"),
										value: <Code>{data.install.dir}</Code>,
									},
								]
							: []),
					]}
				/>
				{update.check === "disabled" && (
					<Text size="sm" c="dimmed">
						{i18n._(
							"The update check is turned off (UPDATE_CHECK_ENABLED=false).",
						)}
					</Text>
				)}
				{update.check === "error" && (
					<Text size="sm" c="red">
						{update.error?.code === "GITHUB_RATE_LIMITED" ||
						update.error?.code === "GITHUB_RATE_LIMITED_SOON"
							? i18n._(
									"The release check is rate limited. Add a GitHub token in Settings → GitHub token.",
								)
							: i18n._("The release check failed: {error}", {
									error: errorText(i18n, update.error),
								})}
					</Text>
				)}
				{blocker && blocker !== "no_update" && (
					<Text size="sm" c="dimmed">
						{i18n._(blockerLabels[blocker])}
					</Text>
				)}
				{last && (
					<Group gap="xs">
						<Text size="sm">
							{i18n._("Last upgrade: {from} → {to}, {date}", {
								from: last.from,
								to: last.to,
								// After hydration: the server's time zone differs.
								date: mounted
									? formatDate(i18n.locale, last.startedAt, {
											dateStyle: "medium",
											timeStyle: "short",
										})
									: "",
							})}
						</Text>
						{last.outcome ? (
							<Badge
								color={outcomeColors[last.outcome]}
								variant="light"
								size="sm"
							>
								{i18n._(outcomeLabels[last.outcome])}
							</Badge>
						) : (
							<Badge variant="light" size="sm">
								{i18n._("Running")}
							</Badge>
						)}
						<Anchor
							size="sm"
							component="button"
							onClick={() => setJob(last.deploymentId)}
						>
							{i18n._("View log")}
						</Anchor>
					</Group>
				)}
				<Text size="sm">
					<Anchor href={data.installGuideUrl} target="_blank" rel="noreferrer">
						{i18n._("Install {appName} on another VPS", { appName: APP_NAME })}
					</Anchor>
				</Text>
			</Stack>

			<Modal
				opened={opened}
				onClose={() => setOpened(false)}
				title={i18n._("Upgrade {appName} to {version}", {
					appName: APP_NAME,
					version: latest?.version ?? "",
				})}
			>
				<Stack>
					<Text size="sm">
						{i18n._(
							"A {appName} backup is taken first, then the new image is pulled and the panel restarts on it. Running jobs must be finished; new jobs wait until the upgrade is over. The page reconnects by itself.",
							{ appName: APP_NAME },
						)}
					</Text>
					{latest?.url && (
						<Anchor
							href={latest.url}
							target="_blank"
							rel="noreferrer"
							size="sm"
						>
							{i18n._("Read the release notes")}
						</Anchor>
					)}
					<Select
						label={i18n._("Back up to")}
						description={i18n._(
							"Required: the way back if the new version migrates the database.",
						)}
						data={(destinations.data ?? []).map((item) => ({
							value: item.id,
							label: item.name,
						}))}
						value={chosenDestination}
						onChange={setDestinationId}
						allowDeselect={false}
						error={
							destinations.data && destinations.data.length === 0
								? i18n._(
										"Add a backup destination first (Data → Destinations).",
									)
								: undefined
						}
					/>
					<Select
						label={i18n._("Upload through server")}
						data={ready.map((item) => ({ value: item.id, label: item.name }))}
						value={serverId ?? ready[0]?.id ?? null}
						onChange={setServerId}
						allowDeselect={false}
						error={
							ready.length === 0 ? i18n._("Needs a ready server.") : undefined
						}
					/>
					<Alert color="orange" variant="light">
						<Text size="sm">
							{i18n._(
								"If the new version does not become healthy, the previous image starts again automatically. The database is not rolled back: if the new version migrated it, restore the backup taken now (README: disaster recovery).",
							)}
						</Text>
					</Alert>
					<Checkbox
						label={i18n._(
							"I understand the database is not rolled back automatically",
						)}
						checked={understood}
						onChange={(event) => setUnderstood(event.currentTarget.checked)}
					/>
					{start.fieldError() && (
						<Text size="sm" c="red">
							{start.fieldError()}
						</Text>
					)}
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setOpened(false)}>
							{i18n._("Cancel")}
						</Button>
						<Button
							loading={start.isPending}
							disabled={!understood || !chosenDestination || ready.length === 0}
							onClick={() => start.mutate()}
						>
							{i18n._("Back up and upgrade")}
						</Button>
					</Group>
				</Stack>
			</Modal>
			<ActionLogDrawer
				opened={job !== null}
				onClose={() => setJob(null)}
				serverName={APP_NAME}
				title={i18n._("Upgrade {appName}", { appName: APP_NAME })}
				deploymentId={job}
				onCompleted={() =>
					queryClient.invalidateQueries({ queryKey: ["upgrade"] })
				}
			/>
		</SectionCard>
	);
};
