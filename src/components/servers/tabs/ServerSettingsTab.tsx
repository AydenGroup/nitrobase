import { useLingui } from "@lingui/react";
import { Badge, Button, Group, Stack, Text, Tooltip } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ActionLogDrawer } from "#/components/servers/ActionLogDrawer";
import { ResourcePolicyCard } from "#/components/servers/ResourcePolicyCard";
import { ServerForm } from "#/components/servers/ServerForm";
import { TunnelCard } from "#/components/servers/TunnelCard";
import { WorkDirsCleanupModal } from "#/components/servers/WorkDirsCleanupModal";
import { useCan } from "#/components/teams/useCan";
import { ConfirmDanger } from "#/components/ui/ConfirmDanger";
import { DataTable } from "#/components/ui/DataTable";
import { notifications } from "#/components/ui/Notifications";
import { SectionCard } from "#/components/ui/SectionCard";
import { STALE_MS } from "#/config/polling.ts";
import { APP_NAME } from "#/config/shared.ts";
import {
	type ServerDTO,
	unknownWipePhrase,
} from "#/features/servers/schema.ts";
import {
	deleteServerFn,
	listOrphansFn,
	wipeOrphanFn,
} from "#/features/servers/servers.functions.ts";
import { localizePath } from "#/libs/i18n";

export const ServerSettingsTab: React.FC<{
	server: ServerDTO;
	busy: boolean;
}> = ({ server, busy }) => {
	const { i18n } = useLingui();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const can = useCan();
	const manage = can("server.manage");
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [wipeTarget, setWipeTarget] = useState<{
		folder: string;
		unknown: boolean;
	} | null>(null);
	const [job, setJob] = useState<string | null>(null);
	const [jobKind, setJobKind] = useState<"wipe" | "sweep">("wipe");

	const orphans = useQuery({
		queryKey: ["servers", server.id, "orphans"],
		queryFn: async () => await listOrphansFn({ data: server.id }),
		enabled: server.status === "ready" && manage,
		staleTime: STALE_MS.medium,
	});

	const remove = useMutation({
		mutationFn: async () => await deleteServerFn({ data: server.id }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["servers"] });
			notifications.success({ message: i18n._("Server removed.") });
			navigate({ to: localizePath("/servers") as never });
		},
		onError: (error: Error) => notifications.error({ message: error.message }),
	});

	const wipe = useMutation({
		mutationFn: async (target: {
			folder: string;
			unknown: boolean;
			typed: string;
		}) =>
			await wipeOrphanFn({
				data: {
					serverId: server.id,
					folder: target.folder,
					confirmName: target.typed,
					forceUnknown: target.unknown,
				},
			}),
		onSuccess: ({ deploymentId }) => {
			setWipeTarget(null);
			setJobKind("wipe");
			setJob(deploymentId);
		},
		// Refusals (foreign owner, running containers) show in the dialog.
		onError: () => orphans.refetch(),
	});

	// Leftover backup staging (a crashed panel can leave rclone.conf there).
	const [cleanupOpen, setCleanupOpen] = useState(false);

	if (!manage) {
		return (
			<SectionCard title={i18n._("Settings")}>
				<Text size="sm" c="dimmed">
					{i18n._(
						"Your role in this team can view this server but not change its settings.",
					)}
				</Text>
			</SectionCard>
		);
	}

	return (
		<Stack gap="md">
			{!server.isDefault && (
				<SectionCard title={i18n._("Connection")}>
					<ServerForm data={server} />
				</SectionCard>
			)}

			<TunnelCard server={server} busy={busy} />

			<ResourcePolicyCard server={server} busy={busy} />

			{server.status === "ready" && (
				<SectionCard
					flush
					title={i18n._("Orphaned app data")}
					description={i18n._(
						"Folders, containers and volumes of apps that were deleted without wiping their data. Only data created by this panel can be wiped here.",
					)}
					actions={
						<Button
							size="xs"
							variant="default"
							disabled={busy}
							onClick={() => setCleanupOpen(true)}
						>
							{i18n._("Clean up leftovers now")}
						</Button>
					}
				>
					<DataTable
						rows={orphans.data ?? []}
						loading={orphans.isLoading}
						getRowKey={(row) => row.folder}
						minWidth={560}
						empty={
							<Text size="sm" c="dimmed" p="md">
								{i18n._("Nothing left behind.")}
							</Text>
						}
						columns={[
							{
								key: "folder",
								header: i18n._("Folder"),
								render: (row) => row.folder,
							},
							{
								key: "what",
								header: i18n._("Contains"),
								render: (row) => (
									<Group gap={4}>
										{row.hasFolder && (
											<Badge size="xs" variant="light">
												{i18n._("Files")}
											</Badge>
										)}
										{row.containers > 0 && (
											<Badge size="xs" variant="light" color="orange">
												{i18n._("{count} containers", {
													count: row.containers,
												})}
											</Badge>
										)}
										{row.volumes.length > 0 && (
											<Badge size="xs" variant="light" color="grape">
												{i18n._("{count} volumes", {
													count: row.volumes.length,
												})}
											</Badge>
										)}
									</Group>
								),
							},
							{
								key: "owner",
								header: i18n._("Owner"),
								render: (row) =>
									row.owner === "self" ? (
										<Badge size="xs" variant="light" color="gray">
											{i18n._("This panel")}
										</Badge>
									) : (
										<Tooltip
											multiline
											w={280}
											label={
												row.owner === "foreign"
													? i18n._(
															"Created by another {appName} instance. Remove it from that panel.",
															{ appName: APP_NAME },
														)
													: i18n._(
															"No owner recorded (created before ownership tags, or by another panel). It is never wiped from here.",
														)
											}
										>
											<Badge size="xs" variant="light" color="yellow">
												{i18n._("Foreign — not managed by this panel")}
											</Badge>
										</Tooltip>
									),
							},
							{
								key: "actions",
								header: "",
								align: "right",
								render: (row) =>
									row.owner === "unknown" &&
									can("instance.manage") &&
									row.running === 0 ? (
										<Tooltip
											multiline
											w={260}
											label={i18n._(
												"Instance administrators can wipe data without a recorded owner after checking no other panel uses it.",
											)}
										>
											<Button
												size="xs"
												color="red"
												variant="subtle"
												disabled={busy}
												onClick={() => {
													wipe.reset();
													setWipeTarget({ folder: row.folder, unknown: true });
												}}
											>
												{i18n._("Wipe…")}
											</Button>
										</Tooltip>
									) : row.owner !== "self" ? null : row.running > 0 ? (
										<Tooltip
											label={i18n._(
												"Its containers are running: stop them before wiping.",
											)}
										>
											<Button size="xs" color="red" variant="subtle" disabled>
												{i18n._("Wipe")}
											</Button>
										</Tooltip>
									) : (
										<Button
											size="xs"
											color="red"
											variant="subtle"
											disabled={busy || !row.wipeable}
											onClick={() => {
												wipe.reset();
												setWipeTarget({ folder: row.folder, unknown: false });
											}}
										>
											{i18n._("Wipe")}
										</Button>
									),
							},
						]}
					/>
				</SectionCard>
			)}

			{!server.isDefault && (
				<SectionCard
					tone="danger"
					title={i18n._("Delete server")}
					description={i18n._(
						"This removes the server from {appName}. Nothing on the server itself is deleted: containers, data and the installed SSH key stay in place.",
						{ appName: APP_NAME },
					)}
				>
					<Button
						color="red"
						variant="light"
						disabled={busy}
						onClick={() => setDeleteOpen(true)}
					>
						{i18n._("Delete server")}
					</Button>
				</SectionCard>
			)}

			<ConfirmDanger
				opened={deleteOpen}
				onClose={() => setDeleteOpen(false)}
				title={i18n._("Delete server")}
				description={i18n._("Apps on this server must be deleted first.")}
				confirmName={server.name}
				confirmLabel={i18n._("Delete")}
				loading={remove.isPending}
				onConfirm={() => remove.mutate()}
			/>
			<ConfirmDanger
				opened={wipeTarget !== null}
				onClose={() => setWipeTarget(null)}
				title={i18n._("Wipe orphaned data")}
				description={
					wipeTarget?.unknown
						? i18n._(
								"{folder} has no recorded owner: it may belong to another {appName} panel or to an app created before ownership marks. Its containers, volumes and folder are removed for good. Only continue if no other panel uses this server's data.",
								{ appName: APP_NAME, folder: wipeTarget.folder },
							)
						: i18n._(
								"Removes the containers, volumes and folder of {folder}. This cannot be undone.",
								{
									folder: wipeTarget?.folder ?? "",
								},
							)
				}
				confirmName={
					wipeTarget
						? wipeTarget.unknown
							? unknownWipePhrase(wipeTarget.folder)
							: wipeTarget.folder
						: ""
				}
				confirmLabel={i18n._("Wipe")}
				loading={wipe.isPending}
				error={wipe.error?.message}
				onConfirm={(typed) =>
					wipeTarget && wipe.mutate({ ...wipeTarget, typed })
				}
			/>
			<WorkDirsCleanupModal
				serverId={server.id}
				opened={cleanupOpen}
				onClose={() => setCleanupOpen(false)}
				onStarted={(deploymentId) => {
					setJobKind("sweep");
					setJob(deploymentId);
				}}
			/>
			<ActionLogDrawer
				opened={job !== null}
				onClose={() => setJob(null)}
				serverName={server.name}
				title={
					jobKind === "sweep"
						? i18n._("Clean up leftovers")
						: i18n._("Wipe orphaned data")
				}
				deploymentId={job}
				onCompleted={(success) => {
					if (success && jobKind === "wipe") {
						notifications.success({ message: i18n._("Orphaned data wiped") });
					}
					if (success && jobKind === "sweep") {
						notifications.success({ message: i18n._("Leftovers cleaned up") });
					}
					orphans.refetch();
				}}
			/>
		</Stack>
	);
};
