import { useLingui } from "@lingui/react";
import { Button, Select, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ActionLogDrawer } from "#/components/servers/ActionLogDrawer";
import { CopyField } from "#/components/ui/CopyField";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { APP_NAME } from "#/config/shared.ts";
import {
	runPanelBackupFn,
	savePanelPolicyFn,
} from "#/features/backups/backups.functions.ts";
import {
	backupsQueryOptions,
	destinationsQueryOptions,
	panelPolicyQueryOptions,
} from "#/features/backups/backups.query.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import { formatDate } from "#/libs/intl.ts";
import { PolicyEditor, type PolicyValues } from "./PolicyEditor";

/** Nitrobase self-backup: schedule + manual run. */
export const PanelBackupCard: React.FC = () => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const destinations = useQuery(destinationsQueryOptions);
	const policy = useQuery(panelPolicyQueryOptions);
	const { data: servers = [] } = useQuery(serversQueryOptions);
	const ready = servers.filter((server) => server.status === "ready");
	const panelBackups = useQuery(
		backupsQueryOptions({ kind: "panel", status: "success" }),
	);
	const latest = [...(panelBackups.data ?? [])].sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	)[0];
	const [serverId, setServerId] = useState<string | null>(null);
	const [job, setJob] = useState<string | null>(null);
	const server = serverId ?? policy.data?.serverId ?? ready[0]?.id ?? null;

	const save = useAppMutation({
		mutationFn: async (values: PolicyValues) =>
			await savePanelPolicyFn({
				data: { ...values, serverId: server ?? "" },
			}),
		success: i18n._("{appName} backup schedule saved", { appName: APP_NAME }),
		field: "policy",
		onSuccess: (data) =>
			queryClient.setQueryData(panelPolicyQueryOptions.queryKey, data),
	});
	const runNow = useAppMutation({
		mutationFn: async () =>
			await runPanelBackupFn({
				data: {
					serverId: server ?? "",
					destinationId:
						policy.data?.destinationId ?? destinations.data?.[0]?.id ?? "",
				},
			}),
		onSuccess: ({ deploymentId }) => setJob(deploymentId),
	});

	return (
		<SectionCard
			title={i18n._("{appName} backup", { appName: APP_NAME })}
			description={i18n._(
				"Dumps the {appName} database (servers, apps, encrypted secrets), encrypts it with ENCRYPTION_KEY and uploads it. Keep ENCRYPTION_KEY somewhere else: without it the backup can't be read.",
				{ appName: APP_NAME },
			)}
			actions={
				<Button
					size="xs"
					variant="light"
					leftSection={<ShieldCheck size={14} />}
					disabled={!server || !destinations.data?.length}
					loading={runNow.isPending}
					onClick={() => runNow.mutate()}
				>
					{i18n._("Back up now")}
				</Button>
			}
		>
			{latest?.checksum && (
				<Stack gap={4} mb="md">
					<Text size="sm" fw={600}>
						{i18n._("Latest {appName} backup: {date}", {
							appName: APP_NAME,
							date: formatDate(i18n.locale, latest.createdAt, {
								dateStyle: "medium",
								timeStyle: "short",
							}),
						})}
					</Text>
					<Text size="xs" c="dimmed">
						{i18n._(
							"Keep this sha256 with ENCRYPTION_KEY: compare it with the downloaded file before restoring.",
						)}
					</Text>
					<CopyField value={latest.checksum} />
				</Stack>
			)}
			{destinations.data && policy.isFetched && (
				<PolicyEditor
					key={policy.data?.id ?? "new"}
					policy={policy.data ?? null}
					destinations={destinations.data}
					saving={save.isPending}
					error={save.fieldError()}
					onChange={save.clearFieldError}
					onSave={(values) => save.mutate(values)}
					extraValid={!!server}
				>
					<Stack gap={2}>
						<Select
							label={i18n._("Upload through server")}
							description={i18n._(
								"rclone runs on this server (a server-folder destination stores the file there).",
							)}
							data={ready.map((item) => ({ value: item.id, label: item.name }))}
							value={server}
							onChange={setServerId}
							allowDeselect={false}
						/>
						{ready.length === 0 && (
							<Text size="xs" c="red">
								{i18n._("Needs a ready server.")}
							</Text>
						)}
					</Stack>
				</PolicyEditor>
			)}
			<ActionLogDrawer
				opened={job !== null}
				onClose={() => setJob(null)}
				serverName={APP_NAME}
				title={i18n._("{appName} backup", { appName: APP_NAME })}
				deploymentId={job}
				onCompleted={() =>
					queryClient.invalidateQueries({ queryKey: ["backups"] })
				}
			/>
		</SectionCard>
	);
};
