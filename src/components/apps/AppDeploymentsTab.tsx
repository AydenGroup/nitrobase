import { useLingui } from "@lingui/react";
import { Button, Card, Code, Stack, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DeploymentStatusBadge } from "#/components/dashboard/StatusBadge";
import { GitReleasesCard } from "#/components/git/GitReleasesCard";
import { titleFor } from "#/config/job-titles.ts";
import { pollWhile } from "#/config/polling.ts";
import { deploymentStatuses, isBusy } from "#/config/status.ts";
import { appDeploymentsQueryOptions } from "#/features/apps/apps.query.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import { formatDate } from "#/libs/intl.ts";
import { AppJobDrawer } from "./AppJobDrawer";
import { useAppJob } from "./useAppJob";

export const AppDeploymentsTab: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { i18n } = useLingui();
	const jobs = useAppJob(overview.app.id);
	const search = useSearch({ strict: false }) as { job?: string };
	// Opened from the deploy wizard: show the live log right away (once).
	const [initialJob] = useState(search.job);
	const { openJob } = jobs;
	const deployTitle = i18n._("Deploy app");
	useEffect(() => {
		if (initialJob) openJob(initialJob, deployTitle);
	}, [initialJob, openJob, deployTitle]);
	const { data: deployments = [] } = useQuery({
		...appDeploymentsQueryOptions(overview.app.id),
		refetchInterval: (query) =>
			pollWhile(
				!!query.state.data?.some((d) => isBusy(deploymentStatuses, d.status)),
			),
	});
	const title = (deployment: (typeof deployments)[number]) =>
		titleFor(i18n, deployment);

	// Open the newest running deploy automatically (e.g. right after "Deploy").
	const running = deployments.find(
		(d) => d.status === "running" && d.type !== "app_terminal",
	);

	return (
		<Stack gap="md">
			{overview.sourceKind === "git" && (
				<GitReleasesCard overview={overview} jobs={jobs} />
			)}
			<Card withBorder p={0}>
				{deployments.length === 0 ? (
					<Text c="dimmed" size="sm" p="md">
						{i18n._("No jobs yet.")}
					</Text>
				) : (
					<Table highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{i18n._("Job")}</Table.Th>
								<Table.Th>{i18n._("Status")}</Table.Th>
								<Table.Th>{i18n._("Commit")}</Table.Th>
								<Table.Th>{i18n._("Started")}</Table.Th>
								<Table.Th />
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{deployments.map((deployment) => (
								<Table.Tr key={deployment.id}>
									<Table.Td>{title(deployment)}</Table.Td>
									<Table.Td>
										<DeploymentStatusBadge
											status={deployment.status}
											warningCount={deployment.warningCount}
										/>
									</Table.Td>
									<Table.Td>
										{deployment.commitSha ? (
											<Code>{deployment.commitSha.slice(0, 12)}</Code>
										) : (
											"—"
										)}
									</Table.Td>
									<Table.Td>
										{formatDate(i18n.locale, deployment.createdAt)}
									</Table.Td>
									<Table.Td>
										{deployment.type !== "app_terminal" && (
											<Button
												size="xs"
												variant={
													deployment.id === running?.id ? "light" : "subtle"
												}
												onClick={() =>
													jobs.openJob(deployment.id, title(deployment))
												}
											>
												{deployment.id === running?.id
													? i18n._("Watch live")
													: i18n._("View logs")}
											</Button>
										)}
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				)}
			</Card>
			<AppJobDrawer
				job={jobs.job}
				appName={overview.app.name}
				onClose={jobs.closeJob}
				onCompleted={() => jobs.refresh()}
			/>
		</Stack>
	);
};
