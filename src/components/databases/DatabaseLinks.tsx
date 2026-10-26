import { useLingui } from "@lingui/react";
import {
	Anchor,
	Badge,
	Button,
	Checkbox,
	Code,
	Group,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import { Link2 } from "lucide-react";
import { useState } from "react";
import { AppStatusBadge } from "#/components/dashboard/StatusBadge";
import { useCan } from "#/components/teams/useCan";
import { DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { unlinkDatabaseFn } from "#/features/databases/databases.functions.ts";
import type { DatabaseLinkView } from "#/features/databases/schema.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { EngineBadge } from "./EngineBadge";

/**
 * Links table, from the database side (`side = "database"`: one row per
 * app) or the app side (one row per database), with unlink.
 */
export const DatabaseLinksTable: React.FC<{
	links: DatabaseLinkView[];
	side: "database" | "app";
	onJob: (deploymentId: string, title: string) => void;
	emptyAction?: React.ReactNode;
}> = ({ links, side, onJob, emptyAction }) => {
	const { i18n } = useLingui();
	const can = useCan();
	const [unlinking, setUnlinking] = useState<DatabaseLinkView | null>(null);
	const [redeploy, setRedeploy] = useState(true);
	const unlink = useAppMutation({
		mutationFn: async (link: DatabaseLinkView) =>
			await unlinkDatabaseFn({ data: { linkId: link.id, redeploy } }),
		onSuccess: ({ deploymentId }) => {
			setUnlinking(null);
			onJob(deploymentId, i18n._("Unlink database"));
		},
	});
	return (
		<>
			<DataTable
				rows={links}
				getRowKey={(link) => link.id}
				minWidth={560}
				empty={
					<EmptyState
						compact
						icon={Link2}
						title={
							side === "database"
								? i18n._("No app uses this database yet")
								: i18n._("No linked databases")
						}
						description={
							side === "database"
								? i18n._(
										"Link an app on the same server to give it the connection URL and a private network to the database.",
									)
								: i18n._(
										"Link a database on this server to get its connection URL as an environment variable.",
									)
						}
					>
						{emptyAction}
					</EmptyState>
				}
				columns={[
					side === "database"
						? {
								key: "app",
								header: i18n._("App"),
								render: (link) => (
									<Group gap={6} wrap="nowrap">
										<Anchor
											component={LocalizedLink}
											to={`/apps/${link.appId}`}
											size="sm"
											fw={600}
										>
											{link.appName}
										</Anchor>
										<AppStatusBadge status={link.appStatus} />
									</Group>
								),
							}
						: {
								key: "database",
								header: i18n._("Database"),
								render: (link) => (
									<Stack gap={2}>
										<Anchor
											component={LocalizedLink}
											to={`/databases/${link.databaseId}`}
											size="sm"
											fw={600}
										>
											{link.databaseName}
										</Anchor>
										<EngineBadge engine={link.databaseEngine} />
									</Stack>
								),
							},
					{
						key: "env",
						header: i18n._("Variables"),
						render: (link) => (
							<Group gap={4}>
								{link.env.map((entry) => (
									<Code key={entry.name}>{entry.name}</Code>
								))}
							</Group>
						),
					},
					{
						key: "login",
						header: i18n._("Login"),
						hideOnMobile: true,
						render: (link) => (
							<Text size="sm" c="dimmed">
								{[link.username ?? i18n._("main user"), link.database]
									.filter(Boolean)
									.join(" · ")}
							</Text>
						),
					},
					{
						key: "pending",
						header: "",
						render: (link) =>
							link.appNeedsRedeploy ? (
								<Badge size="xs" color="yellow" variant="light">
									{i18n._("App needs redeploy")}
								</Badge>
							) : null,
					},
					{
						key: "actions",
						header: "",
						mobile: "actions",
						align: "right",
						render: (link) =>
							can("database.manage") ? (
								<Button
									size="xs"
									variant="subtle"
									color="red"
									onClick={() => setUnlinking(link)}
								>
									{i18n._("Unlink")}
								</Button>
							) : null,
					},
				]}
			/>
			<Modal
				opened={unlinking !== null}
				onClose={() => setUnlinking(null)}
				title={i18n._("Unlink {app} from {database}", {
					app: unlinking?.appName ?? "",
					database: unlinking?.databaseName ?? "",
				})}
			>
				<Stack>
					<Text size="sm">
						{i18n._(
							"The database leaves the private network right away: the app can no longer reach it. Its connection variables are removed when it is redeployed.",
						)}
					</Text>
					<Checkbox
						label={i18n._("Redeploy the app now")}
						checked={redeploy}
						onChange={(event) => setRedeploy(event.currentTarget.checked)}
					/>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setUnlinking(null)}>
							{i18n._("Cancel")}
						</Button>
						<Button
							color="red"
							loading={unlink.isPending}
							onClick={() => unlinking && unlink.mutate(unlinking)}
						>
							{i18n._("Unlink")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
};
