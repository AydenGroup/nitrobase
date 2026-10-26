import { useLingui } from "@lingui/react";
import {
	Anchor,
	Badge,
	Button,
	Card,
	Group,
	Select,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useMounted } from "@mantine/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useCanOnApp } from "#/components/teams/useCan";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	checkAppUpdateFn,
	setUpdatePolicyFn,
} from "#/features/app-updates/app-updates.functions.ts";
import { autoUpdateWindowQueryOptions } from "#/features/app-updates/app-updates.query.ts";
import { errorText } from "#/libs/coded.ts";
import { formatDate, formatRelativeTime } from "#/libs/intl.ts";
import {
	APP_UPDATE_POLICIES,
	type AppUpdatePolicy,
} from "#/server/services/app-updates/policy.ts";
import { AppUpdateBadge } from "./AppUpdateBadge";
import { UpdateAppModal } from "./UpdateAppModal";
import {
	updatePolicyLabels,
	updateResultColors,
	updateResultLabels,
} from "./update-labels";
import { useAppUpdates } from "./useAppUpdates";

/**
 * App overview: newer version, one-click update, "Check for updates",
 * the update policy and the last update's result.
 */
export const AppUpdatesCard: React.FC<{
	appId: string;
	appName: string;
	isDatabase?: boolean;
	onJob: (deploymentId: string, title: string) => void;
}> = ({ appId, appName, isDatabase = false, onJob }) => {
	const { i18n } = useLingui();
	// Dates are formatted after hydration (server time zone differs).
	const mounted = useMounted();
	const can = useCanOnApp(isDatabase);
	const queryClient = useQueryClient();
	const update = useAppUpdates().get(appId);
	const autoWindow = useQuery(autoUpdateWindowQueryOptions);
	const [opened, setOpened] = useState(false);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["app-updates"] });
	const check = useAppMutation({
		mutationFn: async () => await checkAppUpdateFn({ data: appId }),
		success: (view) =>
			view.available
				? i18n._("{version} is available", {
						version: view.name ?? view.version ?? "",
					})
				: view.checkError
					? null
					: i18n._("Up to date"),
		onSuccess: refresh,
	});
	const policy = useAppMutation({
		mutationFn: async (value: AppUpdatePolicy) =>
			await setUpdatePolicyFn({ data: { appId, policy: value } }),
		success: i18n._("Update policy saved"),
		onSuccess: refresh,
	});
	if (!update?.supported) return null;

	return (
		<Card withBorder p="md">
			<Group justify="space-between" mb="sm">
				<Group gap="xs">
					<Title order={5}>{i18n._("Updates")}</Title>
					<AppUpdateBadge update={update} />
				</Group>
				<Group gap="xs">
					{can("app.deploy") && (
						<Button
							size="xs"
							variant="default"
							leftSection={<RefreshCw size={14} />}
							loading={check.isPending}
							onClick={() => check.mutate()}
						>
							{i18n._("Check for updates")}
						</Button>
					)}
					{can("app.deploy") && update.available && (
						<Button
							size="xs"
							leftSection={<ArrowUpCircle size={14} />}
							onClick={() => setOpened(true)}
						>
							{i18n._("Update")}
						</Button>
					)}
				</Group>
			</Group>
			<Stack gap="xs">
				<Text size="sm">
					{update.available
						? i18n._("{to} is available (running {from}).", {
								to: update.name ?? update.version ?? "",
								from: update.current,
							})
						: i18n._("Running {version}: up to date.", {
								version: update.current,
							})}{" "}
					{update.available && update.url && (
						<Anchor
							href={update.url}
							target="_blank"
							rel="noreferrer"
							size="sm"
						>
							{i18n._("Release notes")}
						</Anchor>
					)}
				</Text>
				{update.checkError ? (
					<Text size="xs" c="red">
						{i18n._("The last check failed: {error}", {
							error: errorText(i18n, update.checkError),
						})}
					</Text>
				) : (
					update.checkedAt && (
						<Text size="xs" c="dimmed">
							{i18n._("Checked {when}", {
								when: mounted
									? formatRelativeTime(i18n.locale, update.checkedAt)
									: "",
							})}
						</Text>
					)
				)}
				{update.lastResult && update.lastResultAt && (
					<Group gap="xs">
						<Text size="xs" c="dimmed">
							{i18n._("Last update {when}:", {
								when: mounted
									? formatRelativeTime(i18n.locale, update.lastResultAt)
									: "",
							})}
						</Text>
						<Badge
							size="xs"
							variant="light"
							color={updateResultColors[update.lastResult]}
						>
							{i18n._(updateResultLabels[update.lastResult])}
						</Badge>
						{update.lastDeploymentId && (
							<Anchor
								size="xs"
								component="button"
								onClick={() =>
									onJob(
										update.lastDeploymentId as string,
										i18n._("Update {name}", { name: appName }),
									)
								}
							>
								{i18n._("View log")}
							</Anchor>
						)}
					</Group>
				)}
				<Select
					label={i18n._("Update policy")}
					description={
						autoWindow.data?.nextStart && mounted
							? i18n._(
									"Automatic updates run in the maintenance window: next {start} for {minutes} minutes ({zone}). They always back up first; major versions are never applied automatically.",
									{
										start: formatDate(i18n.locale, autoWindow.data.nextStart, {
											dateStyle: "medium",
											timeStyle: "short",
										}),
										minutes: autoWindow.data.minutes,
										zone: autoWindow.data.timeZone,
									},
								)
							: undefined
					}
					data={APP_UPDATE_POLICIES.map((value) => ({
						value,
						label: i18n._(updatePolicyLabels[value]),
					}))}
					value={update.policy}
					onChange={(value) => value && policy.mutate(value as AppUpdatePolicy)}
					disabled={!can("app.update_policy.manage") || policy.isPending}
					allowDeselect={false}
				/>
			</Stack>
			<UpdateAppModal
				appId={appId}
				appName={appName}
				update={opened ? update : null}
				onClose={() => setOpened(false)}
				onStarted={(id, title) => {
					onJob(id, title);
					refresh();
				}}
			/>
		</Card>
	);
};
