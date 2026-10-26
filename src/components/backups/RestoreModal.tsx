import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	Group,
	Modal,
	SegmentedControl,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useFreeDomainProvider } from "#/components/apps/useFreeDomainProvider";
import {
	liveServerStatus,
	useUnreachableServers,
} from "#/components/monitoring/ServerLiveStatus";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { EXAMPLES } from "#/config/shared.ts";
import {
	restoreBackupFn,
	restoreClonePreviewFn,
} from "#/features/backups/backups.functions.ts";
import type { BackupDTO } from "#/features/backups/schema.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import { errorText } from "#/libs/coded.ts";
import { localizePath, translateTemplateText } from "#/libs/i18n";
import { formatDate, formatList } from "#/libs/intl.ts";
import { internalError } from "#/utils/error.ts";

/** Restore: overwrite the backed-up app, or clone into a new app. */
export const RestoreModal: React.FC<{
	backup: BackupDTO | null;
	onClose: () => void;
	/** Opens the job log (overwrite stays on the page). */
	onStarted: (deploymentId: string, title: string) => void;
}> = ({ backup, onClose, onStarted }) => {
	const { i18n } = useLingui();
	const freeDomainProvider = useFreeDomainProvider();
	const navigate = useNavigate();
	const { data: servers = [] } = useQuery(serversQueryOptions);
	const unreachable = useUnreachableServers();
	// Ready and reachable now (monitoring), like the status badges show.
	const ready = servers.filter(
		(server) => liveServerStatus(server, unreachable) === "ready",
	);
	const [mode, setMode] = useState<"overwrite" | "clone">("overwrite");
	const [confirmName, setConfirmName] = useState("");
	const [serverId, setServerId] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [domain, setDomain] = useState("");
	useEffect(() => {
		if (!backup) return;
		setMode(backup.appId ? "overwrite" : "clone");
		setConfirmName("");
		setServerId(backup.serverId);
		setName(`${backup.appName ?? ""} (restored)`);
		setDomain("");
	}, [backup]);

	const preview = useQuery({
		queryKey: ["backups", backup?.id, "clone-preview"],
		queryFn: () => restoreClonePreviewFn({ data: { id: backup?.id ?? "" } }),
		enabled: !!backup && mode === "clone",
		staleTime: Number.POSITIVE_INFINITY,
	});

	const restore = useAppMutation({
		mutationFn: async () => {
			if (!backup) throw internalError("No backup");
			return mode === "overwrite"
				? await restoreBackupFn({
						data: { id: backup.id, mode, confirmName },
					})
				: await restoreBackupFn({
						data: {
							id: backup.id,
							mode,
							serverId: serverId ?? "",
							name,
							domain: domain || undefined,
						},
					});
		},
		field: "restore",
		onSuccess: ({ appId, deploymentId }) => {
			onClose();
			if (mode === "clone") {
				navigate({
					to: localizePath(`/apps/${appId}`) as never,
					search: { tab: "deployments", job: deploymentId } as never,
				});
			} else {
				onStarted(deploymentId, i18n._("Restore"));
			}
		},
	});

	const canSubmit =
		mode === "overwrite"
			? confirmName.trim() === backup?.folder
			: !!serverId && !!name.trim() && !preview.data?.blocked;

	return (
		<Modal
			opened={backup !== null}
			onClose={onClose}
			title={i18n._("Restore backup")}
			centered
			size="lg"
		>
			<Stack>
				<Text size="sm" c="dimmed">
					{backup?.appName} · {backup?.version} ·{" "}
					{backup
						? formatDate(i18n.locale, backup.createdAt, {
								dateStyle: "medium",
								timeStyle: "short",
							})
						: ""}
				</Text>
				<SegmentedControl
					value={mode}
					onChange={(value) => {
						restore.clearFieldError();
						setMode(value as "overwrite" | "clone");
					}}
					// The source app is gone (appId cleared on delete): only a new
					// app can be restored.
					data={[
						...(backup?.appId
							? [{ value: "overwrite", label: i18n._("Overwrite the app") }]
							: []),
						{ value: "clone", label: i18n._("Restore as a new app") },
					]}
				/>
				{mode === "overwrite" ? (
					<>
						<Alert color="red">
							{i18n._(
								"The app is stopped and its data, database and settings are replaced by the backup. Anything changed since the backup is lost.",
							)}
						</Alert>
						<TextInput
							label={i18n._("Type {name} to confirm.", {
								name: backup?.folder ?? "",
							})}
							value={confirmName}
							onChange={(event) => setConfirmName(event.currentTarget.value)}
							autoComplete="off"
						/>
					</>
				) : (
					<>
						<Select
							label={i18n._("Server")}
							data={ready.map((server) => ({
								value: server.id,
								label: `${server.name} (${server.host})`,
							}))}
							value={serverId}
							onChange={setServerId}
							allowDeselect={false}
						/>
						<TextInput
							label={i18n._("App name")}
							value={name}
							onChange={(event) => setName(event.currentTarget.value)}
						/>
						<TextInput
							label={i18n._("Domain")}
							placeholder={EXAMPLES.appHost}
							description={i18n._(
								"Leave empty for a free {provider} domain. The new app gets its own domains; published ports are not copied. Secrets (keys, passwords) are copied so the data stays readable: rotate them in the new app if it must not share keys with the original.",
								{ provider: freeDomainProvider },
							)}
							value={domain}
							onChange={(event) => setDomain(event.currentTarget.value)}
						/>
						{preview.data?.blocked && (
							<Alert color="red">{errorText(i18n, preview.data.blocked)}</Alert>
						)}
						{!!preview.data?.recomputed.length && (
							<Text size="sm" c="dimmed">
								{i18n._("Recomputed for the new domain: {names}", {
									names: formatList(
										i18n.locale,
										preview.data.recomputed.map((item) =>
											translateTemplateText(i18n, item.label),
										),
									),
								})}
							</Text>
						)}
						{!!preview.data?.kept.length && (
							<Text size="sm" c="dimmed">
								{i18n._(
									"Kept from the original app (sign-in still works): {names}",
									{
										names: formatList(
											i18n.locale,
											preview.data.kept.map((item) =>
												translateTemplateText(i18n, item.label),
											),
										),
									},
								)}
							</Text>
						)}
						{!!preview.data?.fromData.length && (
							<Text size="sm" c="dimmed">
								{i18n._(
									"Come from the restored data, not the app's settings: {names}. Sign in with the values the original app used at backup time (including changes made in the app itself).",
									{
										names: formatList(
											i18n.locale,
											preview.data.fromData.map((item) =>
												translateTemplateText(i18n, item.label),
											),
										),
									},
								)}
							</Text>
						)}
					</>
				)}
				{restore.fieldError() && (
					<Text size="sm" c="red">
						{restore.fieldError()}
					</Text>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{i18n._("Cancel")}
					</Button>
					<Button
						color={mode === "overwrite" ? "red" : undefined}
						disabled={!canSubmit}
						loading={restore.isPending}
						onClick={() => restore.mutate()}
					>
						{i18n._("Restore")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
