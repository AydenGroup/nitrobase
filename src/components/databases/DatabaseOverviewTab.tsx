import { useLingui } from "@lingui/react";
import {
	Alert,
	Anchor,
	Badge,
	Button,
	Group,
	SimpleGrid,
	Stack,
	Text,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Plus, RefreshCw, RotateCw, Square } from "lucide-react";
import { useState } from "react";
import { AppJobDrawer } from "#/components/apps/AppJobDrawer";
import { AppUpdatesCard } from "#/components/apps/AppUpdatesCard";
import { useAppJob } from "#/components/apps/useAppJob";
import { useCan, useCanOnApp } from "#/components/teams/useCan";
import { CopyField } from "#/components/ui/CopyField";
import { ErrorText } from "#/components/ui/ErrorText.tsx";
import { KeyValueList } from "#/components/ui/KeyValueList";
import { SecretField } from "#/components/ui/SecretField";
import { SectionCard } from "#/components/ui/SectionCard";
import { databaseEngine } from "#/config/database-engines.ts";
import { appStatuses, isBusy } from "#/config/status.ts";
import { appActionFn } from "#/features/apps/apps.functions.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import { revealDatabaseFn } from "#/features/databases/databases.functions.ts";
import { databaseSizeQueryOptions } from "#/features/databases/databases.query.ts";
import type {
	DatabaseEndpointView,
	DatabaseOverview,
} from "#/features/databases/schema.ts";
import { errorInfo } from "#/libs/coded.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatBytes } from "#/libs/intl.ts";
import { DatabaseLinksTable } from "./DatabaseLinks";
import { LinkDatabaseModal } from "./LinkDatabaseModal";

/** One endpoint: URL (password masked, reveal audited) and client command. */
const EndpointBlock: React.FC<{
	databaseId: string;
	endpoint: DatabaseEndpointView;
	kind: "internal" | "external";
}> = ({ databaseId, endpoint, kind }) => {
	const { i18n } = useLingui();
	const can = useCan();
	return (
		<Stack gap="xs">
			<KeyValueList
				items={[
					{ label: i18n._("Host"), value: <CopyField value={endpoint.host} /> },
					{
						label: i18n._("Port"),
						value: <CopyField value={String(endpoint.port)} />,
					},
				]}
			/>
			<Text size="xs" c="dimmed" fw={500} tt="uppercase">
				{i18n._("Connection URL")}
			</Text>
			<CopyField value={endpoint.url} />
			{can("database.credentials.reveal") && (
				<>
					<Text size="xs" c="dimmed" fw={500} tt="uppercase">
						{i18n._("Connection URL with password")}
					</Text>
					<SecretField
						name={i18n._("the connection URL")}
						onReveal={async () =>
							(await revealDatabaseFn({ data: { databaseId, endpoint: kind } }))
								.url
						}
					/>
				</>
			)}
			<Text size="xs" c="dimmed" fw={500} tt="uppercase">
				{i18n._("Command line")}
			</Text>
			<CopyField value={endpoint.command} block />
		</Stack>
	);
};

export const DatabaseOverviewTab: React.FC<{
	overview: AppOverview;
	database: DatabaseOverview;
}> = ({ overview, database }) => {
	const { i18n } = useLingui();
	const can = useCanOnApp(true);
	const queryClient = useQueryClient();
	const jobs = useAppJob(overview.app.id);
	const [linkOpen, setLinkOpen] = useState(false);
	const size = useQuery({
		...databaseSizeQueryOptions(database.id),
		enabled: database.status === "running",
	});
	const definition = databaseEngine(database.engine);
	const refresh = () => {
		jobs.refresh();
		queryClient.invalidateQueries({ queryKey: ["databases"] });
	};
	const linkButton = can("database.manage") ? (
		<Button
			size="xs"
			variant="light"
			leftSection={<Plus size={14} />}
			onClick={() => setLinkOpen(true)}
		>
			{i18n._("Link an app")}
		</Button>
	) : null;

	const app = overview.app;
	const deployed = overview.services.length > 0;
	const busy = isBusy(appStatuses, app.status);
	const action = (
		kind: "redeploy" | "start" | "restart" | "stop",
		title: string,
	) =>
		jobs.startJob({
			title,
			start: () => appActionFn({ data: { appId: app.id, action: kind } }),
		});

	return (
		<Stack gap="md">
			{can("app.deploy") && (
				<Group gap="sm">
					<Button
						variant="default"
						leftSection={<RefreshCw size={16} />}
						loading={jobs.isStarting}
						disabled={busy}
						onClick={() => action("redeploy", i18n._("Redeploy"))}
					>
						{i18n._("Redeploy")}
					</Button>
					<Button
						variant="default"
						leftSection={<Play size={16} />}
						disabled={busy || app.status === "running" || !deployed}
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
				</Group>
			)}
			{overview.app.needsRedeploy && (
				<Alert color="yellow">
					{i18n._(
						"Settings changed since the last deploy: redeploy the database to apply them.",
					)}
				</Alert>
			)}
			{overview.networkFixPending && (
				<Alert
					color="yellow"
					title={i18n._("Redeploy to finish the network fix")}
				>
					{i18n._(
						"This database was deployed before its services were kept off shared networks under their service names. It runs, but its files on the server still use the old setup: redeploy it to finish the fix.",
					)}
				</Alert>
			)}
			{overview.app.lastError && overview.app.status === "error" && (
				<Alert color="red" title={i18n._("Last error")}>
					<ErrorText
						error={errorInfo(
							overview.app.lastError,
							overview.app.lastErrorCode,
							overview.app.lastErrorParams,
						)}
					/>
				</Alert>
			)}
			<SimpleGrid cols={{ base: 1, md: 3 }}>
				<SectionCard title={i18n._("Login")}>
					<KeyValueList
						cols={1}
						items={[
							...(database.user !== null
								? [
										{
											label: i18n._("User"),
											value: <CopyField value={database.user} />,
										},
									]
								: []),
							...(database.database !== null
								? [
										{
											label: i18n._("Database"),
											value: <CopyField value={database.database} />,
										},
									]
								: []),
							{
								label: i18n._("Password"),
								value: can("database.credentials.reveal") ? (
									<SecretField
										name={i18n._("the database password")}
										onReveal={async () =>
											(
												await revealDatabaseFn({
													data: {
														databaseId: database.id,
														endpoint: "internal",
													},
												})
											).password
										}
									/>
								) : (
									<Text size="sm" c="dimmed">
										{i18n._("Hidden")}
									</Text>
								),
							},
						]}
					/>
				</SectionCard>
				<SectionCard title={i18n._("Details")}>
					<KeyValueList
						cols={1}
						items={[
							{
								label: i18n._("Engine"),
								value: `${definition.name} ${database.tag}`,
							},
							{
								label: i18n._("Size"),
								value:
									size.data?.sizeBytes != null
										? formatBytes(i18n.locale, size.data.sizeBytes)
										: "—",
							},
							{
								label: i18n._("Linked apps"),
								value: String(database.links.length),
							},
						]}
					/>
				</SectionCard>
				<SectionCard title={i18n._("Network")}>
					<Stack gap="xs">
						<Group gap={6}>
							<Badge variant="light" color="green">
								{i18n._("Private")}
							</Badge>
							{database.external && (
								<Badge
									variant="light"
									color={database.external.loopback ? "yellow" : "red"}
								>
									{database.external.loopback
										? i18n._("Published on 127.0.0.1")
										: i18n._("Published on the network")}
								</Badge>
							)}
						</Group>
						<Text size="sm" c="dimmed">
							{database.external
								? database.external.loopback
									? i18n._(
											"Reachable from linked apps, and on the server's 127.0.0.1 (through an SSH tunnel).",
										)
									: i18n._(
											"Reachable from linked apps and from the network on the published port: keep the password strong and restrict the port with a firewall.",
										)
								: i18n._(
										"Only linked apps can reach it. Publish the port in Settings to connect from outside.",
									)}
						</Text>
					</Stack>
				</SectionCard>
			</SimpleGrid>

			<SectionCard
				title={i18n._("Connect")}
				description={i18n._(
					"From linked apps (private network), and from outside when the port is published.",
				)}
			>
				<SimpleGrid cols={{ base: 1, md: database.external ? 2 : 1 }}>
					<Stack gap="xs">
						<Text fw={600} size="sm">
							{i18n._("From linked apps")}
						</Text>
						<EndpointBlock
							databaseId={database.id}
							endpoint={database.internal}
							kind="internal"
						/>
					</Stack>
					{database.external && (
						<Stack gap="xs">
							<Text fw={600} size="sm">
								{i18n._("From outside")}
							</Text>
							<EndpointBlock
								databaseId={database.id}
								endpoint={database.external}
								kind="external"
							/>
							{database.external.tunnel && (
								<>
									<Text size="xs" c="dimmed">
										{i18n._(
											"Published on the server's 127.0.0.1 only: open an SSH tunnel from your computer first, then connect to 127.0.0.1 on the same port.",
										)}
									</Text>
									<CopyField value={database.external.tunnel} block />
								</>
							)}
						</Stack>
					)}
				</SimpleGrid>
				<Text size="xs" c="dimmed" mt="sm">
					{i18n._(
						"Traffic is not encrypted (no TLS): from outside, prefer the SSH tunnel. Client: {cli}.",
						{ cli: definition.cli },
					)}{" "}
					{!database.external && can("app.env.edit") && (
						<Anchor
							size="xs"
							component={LocalizedLink}
							to={`/databases/${database.id}`}
							search={{ tab: "settings" }}
						>
							{i18n._("Publish the port")}
						</Anchor>
					)}
				</Text>
			</SectionCard>

			<AppUpdatesCard
				appId={overview.app.id}
				appName={overview.app.name}
				isDatabase
				onJob={(id, title) => jobs.openJob(id, title)}
			/>

			<SectionCard
				title={i18n._("Linked apps")}
				actions={database.links.length > 0 ? linkButton : undefined}
				flush
			>
				<DatabaseLinksTable
					links={database.links}
					side="database"
					onJob={(id, title) => jobs.openJob(id, title)}
					emptyAction={linkButton}
				/>
			</SectionCard>

			<LinkDatabaseModal
				opened={linkOpen}
				onClose={() => setLinkOpen(false)}
				serverId={database.server.id}
				database={{
					id: database.id,
					engine: database.engine,
					name: database.name,
				}}
				linkedIds={database.links.map((link) => link.appId)}
				onStarted={(id) => {
					jobs.openJob(id, i18n._("Link database"));
					refresh();
				}}
			/>
			<AppJobDrawer
				job={jobs.job}
				appName={database.name}
				onClose={jobs.closeJob}
				onCompleted={refresh}
			/>
		</Stack>
	);
};
