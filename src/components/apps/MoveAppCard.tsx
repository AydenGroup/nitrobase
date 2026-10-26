import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	Card,
	Group,
	Select,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useFreeDomainProvider } from "#/components/apps/useFreeDomainProvider";
import {
	liveServerStatus,
	useUnreachableServers,
} from "#/components/monitoring/ServerLiveStatus";
import { ConfirmDanger } from "#/components/ui/ConfirmDanger";
import { destinationCapabilities } from "#/config/backup-drivers.ts";
import { moveAppFn } from "#/features/apps/apps.functions.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import { destinationsQueryOptions } from "#/features/backups/backups.query.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import type { useAppJob } from "./useAppJob";

/**
 * Move the app to another Ready server of the team. The archive travels
 * through a destination both servers reach, so server-folder destinations
 * are not offered.
 */
export const MoveAppCard: React.FC<{
	overview: AppOverview;
	jobs: ReturnType<typeof useAppJob>;
}> = ({ overview, jobs }) => {
	const { i18n } = useLingui();
	const freeDomainProvider = useFreeDomainProvider();
	const { app } = overview;
	const servers = useQuery(serversQueryOptions);
	const destinations = useQuery(destinationsQueryOptions);
	const [target, setTarget] = useState<string | null>(null);
	const [destination, setDestination] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);

	const unreachable = useUnreachableServers();
	// Ready and reachable now (an open "unreachable" alert counts as down).
	const targets = (servers.data ?? []).filter(
		(server) =>
			server.id !== app.serverId &&
			liveServerStatus(server, unreachable) === "ready",
	);
	const reachable = (destinations.data ?? []).filter(
		(item) => !destinationCapabilities(item.type).onServer,
	);
	const targetName = targets.find((server) => server.id === target)?.name;

	return (
		<Card withBorder p="md">
			<Title order={5} mb="xs">
				{i18n._("Move to another server")}
			</Title>
			<Text size="sm" c="dimmed" mb="sm">
				{i18n._(
					"Backs the app up, restores it with the same data on the target, checks it is healthy, then removes it here. If anything fails, the app stays on this server. The app is stopped during the move.",
				)}
			</Text>
			{targets.length === 0 ? (
				<Text size="sm" c="dimmed">
					{i18n._("No other Ready server in this team.")}
				</Text>
			) : (
				<Stack gap="sm">
					<Group align="flex-end" wrap="wrap">
						<Select
							label={i18n._("Target server")}
							data={targets.map((server) => ({
								value: server.id,
								// Host too: similar names ("jbox", "jbox2") stay distinct.
								label: `${server.name} (${server.isDefault ? i18n._("Local host") : server.host})`,
							}))}
							value={target}
							onChange={setTarget}
							w={260}
						/>
						<Select
							label={i18n._("Through destination")}
							description={i18n._("S3, R2 or B2: both servers must reach it.")}
							data={reachable.map((item) => ({
								value: item.id,
								label: item.name,
							}))}
							value={destination}
							onChange={setDestination}
							w={260}
						/>
						<Button
							variant="light"
							disabled={!target || !destination}
							loading={jobs.isStarting}
							onClick={() => setConfirming(true)}
						>
							{i18n._("Move app")}
						</Button>
					</Group>
					{reachable.length === 0 && (
						<Alert color="yellow">
							{i18n._(
								"Add an S3, R2 or B2 destination first: a server folder can only be read by its own server.",
							)}
						</Alert>
					)}
				</Stack>
			)}
			<ConfirmDanger
				opened={confirming}
				onClose={() => setConfirming(false)}
				title={i18n._("Move {app} to {server}", {
					app: app.name,
					server: targetName ?? "",
				})}
				description={i18n._(
					"The app is offline until it runs on the target. Domains you manage yourself must then point at the new server's IP (the job log lists them); free {provider} domains are re-pointed automatically.",
					{ provider: freeDomainProvider },
				)}
				confirmName={app.folder}
				confirmLabel={i18n._("Move app")}
				onConfirm={() => {
					setConfirming(false);
					if (!target || !destination) return;
					jobs.startJob({
						title: i18n._("Move app"),
						start: () =>
							moveAppFn({
								data: {
									appId: app.id,
									targetServerId: target,
									destinationId: destination,
								},
							}),
					});
				}}
			/>
		</Card>
	);
};
