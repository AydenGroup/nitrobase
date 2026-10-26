import { useLingui } from "@lingui/react";
import { Alert, Button, Code, Group, Stack, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation } from "@tanstack/react-query";
import { Pencil, PlugZap, Rocket, ShieldAlert } from "lucide-react";
import { ActionLogDrawer } from "#/components/servers/ActionLogDrawer";
import { openBootstrapConfirm } from "#/components/servers/BootstrapConfirm";
import { useServerJob } from "#/components/servers/useServerJob";
import { useCan } from "#/components/teams/useCan";
import { ErrorText } from "#/components/ui/ErrorText.tsx";
import { KeyValueList } from "#/components/ui/KeyValueList";
import { notifications } from "#/components/ui/Notifications";
import { SectionCard } from "#/components/ui/SectionCard";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { serverStatusMeta } from "#/config/status.ts";
import type { ServerDTO } from "#/features/servers/schema.ts";
import { resetHostKeyFn } from "#/features/servers/servers.functions.ts";
import { errorInfo } from "#/libs/coded.ts";
import { toneColors } from "#/theme/tokens.ts";

export const ServerOverviewTab: React.FC<{
	server: ServerDTO;
	busy: boolean;
	onEdit: () => void;
}> = ({ server, busy, onEdit }) => {
	const { i18n } = useLingui();
	const can = useCan();
	const jobs = useServerJob(server.id);
	const meta = serverStatusMeta(server);
	// Reachable again but Docker and Traefik were recorded: most likely a
	// Ready server downgraded by an old failed test (BUG-002). Never
	// restored silently: bootstrap verifies it.
	const looksBootstrapped =
		server.status === "reachable" &&
		!!server.dockerVersion &&
		!!server.traefikVersion;
	const lastError = server.lastError
		? errorInfo(server.lastError, server.lastErrorCode, server.lastErrorParams)
		: null;
	// The SSH host key no longer matches the trusted one: possibly an
	// attack, so its own prominent state (every SSH path refuses anyway;
	// the status is kept).
	const hostKeyChanged = server.lastErrorCode === "HOST_KEY_MISMATCH";
	const otherError = hostKeyChanged ? null : lastError;

	const trust = useMutation({
		mutationFn: async () => await resetHostKeyFn({ data: server.id }),
		onSuccess: () => {
			jobs.refresh();
			notifications.success({
				message: i18n._(
					"Host key cleared. The next connection will trust the server's current key.",
				),
			});
		},
		onError: (error: Error) => notifications.error({ message: error.message }),
	});
	const confirmTrust = () =>
		modals.openConfirmModal({
			title: i18n._("Trust new host key"),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._(
						"Only do this if you reinstalled or replaced the server. If the host key changed unexpectedly, someone may be intercepting the connection.",
					)}
				</Text>
			),
			labels: { confirm: i18n._("Trust new key"), cancel: i18n._("Cancel") },
			confirmProps: { color: "orange" },
			onConfirm: () => trust.mutate(),
		});

	const testButton = (
		<Button
			variant={meta.action === "test" ? "filled" : "light"}
			leftSection={<PlugZap size={16} />}
			loading={jobs.isStarting}
			disabled={busy}
			onClick={() =>
				jobs.start({
					action: "connection_test",
					title: i18n._("Test connection"),
				})
			}
		>
			{i18n._("Test connection")}
		</Button>
	);
	const bootstrapButton = (
		<Button
			variant={meta.action === "bootstrap" ? "filled" : "light"}
			leftSection={<Rocket size={16} />}
			loading={jobs.isStarting}
			disabled={busy}
			onClick={() =>
				openBootstrapConfirm(i18n, server, ({ takeover }) =>
					jobs.start({
						action: "bootstrap",
						title: i18n._("Bootstrap server"),
						takeover,
					}),
				)
			}
		>
			{server.status === "ready"
				? i18n._("Re-run bootstrap")
				: i18n._("Bootstrap server")}
		</Button>
	);

	return (
		<Stack gap="md">
			<Alert
				color={toneColors[meta.tone]}
				variant="light"
				title={
					<Group gap="xs">
						{i18n._("Status")} <StatusBadge meta={meta} />
					</Group>
				}
			>
				<Stack gap="sm">
					<Text size="sm">{i18n._(meta.hint)}</Text>
					{looksBootstrapped && (
						<Text size="sm" fw={500}>
							{i18n._(
								"This server looks bootstrapped (Docker and Traefik were installed). Run Bootstrap to verify it and mark it Ready.",
							)}
						</Text>
					)}
					{otherError && server.status !== "ready" && (
						<ErrorText c={toneColors.danger} error={otherError} />
					)}
					{can("server.manage") && (
						<Group gap="xs">
							{meta.action === "edit" && !server.isDefault && (
								<Button leftSection={<Pencil size={16} />} onClick={onEdit}>
									{i18n._("Edit connection")}
								</Button>
							)}
							{testButton}
							{bootstrapButton}
						</Group>
					)}
				</Stack>
			</Alert>

			{hostKeyChanged && (
				<Alert
					color={toneColors.danger}
					variant="light"
					icon={<ShieldAlert size={16} />}
					title={i18n._(
						"The server's host key changed: verify the fingerprint before trusting it",
					)}
				>
					<Stack gap="sm">
						<ErrorText error={lastError} />
						{can("server.manage") && server.hostKeyFingerprint && (
							<Group>
								<Button
									size="xs"
									color={toneColors.danger}
									variant="light"
									loading={trust.isPending}
									disabled={busy}
									onClick={confirmTrust}
								>
									{i18n._("Trust new host key")}
								</Button>
							</Group>
						)}
					</Stack>
				</Alert>
			)}

			{otherError && server.status === "ready" && (
				<Alert
					color={toneColors.warning}
					variant="light"
					title={i18n._("Last attempt failed")}
				>
					<Stack gap="xs">
						<Text size="sm">
							{i18n._(
								"The server stays Ready. Test the connection again once the problem is fixed.",
							)}
						</Text>
						<ErrorText error={otherError} />
					</Stack>
				</Alert>
			)}

			<SectionCard title={i18n._("Details")}>
				<KeyValueList
					items={[
						{
							label: i18n._("Operating system"),
							value: server.os ?? i18n._("Unknown OS"),
						},
						{
							label: i18n._("Docker"),
							value: server.dockerVersion ?? i18n._("Not installed"),
						},
						{
							label: i18n._("Traefik"),
							value: server.traefikVersion ?? i18n._("Not installed"),
						},
						{
							label: i18n._("SSH"),
							value: server.isDefault
								? i18n._("Local host")
								: `${server.username}@${server.host}:${server.port}`,
						},
					]}
				/>
			</SectionCard>

			{!server.isDefault && (
				<SectionCard
					title={i18n._("SSH host key")}
					description={i18n._(
						"Recorded on the first connection and verified on every connection after that.",
					)}
					actions={
						server.hostKeyFingerprint && can("server.manage") ? (
							<Button
								size="xs"
								variant="subtle"
								color="orange"
								loading={trust.isPending}
								disabled={busy}
								onClick={confirmTrust}
							>
								{i18n._("Trust new host key")}
							</Button>
						) : undefined
					}
				>
					<Code>
						{server.hostKeyFingerprint ??
							i18n._("Not recorded yet (saved on first connection)")}
					</Code>
				</SectionCard>
			)}

			<ActionLogDrawer
				opened={jobs.job !== null}
				onClose={jobs.closeJob}
				serverName={server.name}
				title={jobs.job?.title}
				deploymentId={jobs.job?.id ?? null}
				onCompleted={() => jobs.refresh()}
			/>
		</Stack>
	);
};
