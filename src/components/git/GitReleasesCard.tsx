import { useLingui } from "@lingui/react";
import { Button, Code, Group, Stack, Table, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, RotateCcw } from "lucide-react";
import type { useAppJob } from "#/components/apps/useAppJob";
import { useCan } from "#/components/teams/useCan";
import { LocalDate } from "#/components/ui/LocalDate";
import { SectionCard } from "#/components/ui/SectionCard";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { builders } from "#/config/builders.ts";
import { lookup } from "#/config/labels.ts";
import { pollWhile } from "#/config/polling.ts";
import { isBusy, liveReleaseStatus, releaseStatuses } from "#/config/status.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import { deployCommitFn, rollbackFn } from "#/features/git/git.functions.ts";
import {
	gitAppQueryOptions,
	releasesQueryOptions,
} from "#/features/git/git.query.ts";
import type { ReleaseView } from "#/features/git/schema.ts";
import { formatDuration } from "#/libs/intl.ts";

/**
 * Builds of a git app (Deployments tab): commit, author, builder, status,
 * the live one marked; "Roll back to this" redeploys a kept image without
 * rebuilding; "Deploy latest commit" builds the branch tip.
 */
export const GitReleasesCard: React.FC<{
	overview: AppOverview;
	jobs: ReturnType<typeof useAppJob>;
}> = ({ overview, jobs }) => {
	const { i18n } = useLingui();
	const can = useCan();
	const appId = overview.app.id;
	const { data: git } = useQuery(gitAppQueryOptions(appId));
	const { data: releases = [] } = useQuery({
		...releasesQueryOptions(appId),
		refetchInterval: (query) =>
			pollWhile(
				!!query.state.data?.some((item) =>
					isBusy(releaseStatuses, item.status),
				),
			),
	});
	const deployTitle = i18n._("Build and deploy");
	const rollbackTitle = i18n._("Roll back");

	const confirmRollback = (release: ReleaseView) =>
		modals.openConfirmModal({
			title: i18n._("Roll back to {commit}?", {
				commit: release.commitSha.slice(0, 12),
			}),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._(
						"The kept image of this build is started again (no rebuild). The app's current environment and settings are used.",
					)}
				</Text>
			),
			labels: { confirm: rollbackTitle, cancel: i18n._("Cancel") },
			onConfirm: () =>
				jobs.startJob({
					title: rollbackTitle,
					start: () => rollbackFn({ data: { appId, releaseId: release.id } }),
				}),
		});

	return (
		<SectionCard
			title={i18n._("Builds")}
			description={
				git
					? i18n._("{repository} · branch {branch}", {
							repository: git.source.repoUrl,
							branch: git.source.branch,
						})
					: undefined
			}
			actions={
				can("app.deploy") && (
					<Button
						size="xs"
						leftSection={<GitBranch size={14} />}
						loading={jobs.isStarting}
						onClick={() =>
							jobs.startJob({
								title: deployTitle,
								start: () => deployCommitFn({ data: { appId } }),
							})
						}
					>
						{i18n._("Deploy latest commit")}
					</Button>
				)
			}
			flush
		>
			{releases.length === 0 ? (
				<Text c="dimmed" size="sm" p="md">
					{i18n._("No builds yet.")}
				</Text>
			) : (
				<Table.ScrollContainer minWidth={720}>
					<Table highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{i18n._("Commit")}</Table.Th>
								<Table.Th>{i18n._("Builder")}</Table.Th>
								<Table.Th>{i18n._("Status")}</Table.Th>
								<Table.Th>{i18n._("Built")}</Table.Th>
								<Table.Th />
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{releases.map((release) => {
								const builder = lookup(builders, release.builder);
								return (
									<Table.Tr key={release.id}>
										<Table.Td>
											<Stack gap={0}>
												<Group gap="xs" wrap="nowrap">
													<Code>{release.commitSha.slice(0, 12)}</Code>
													<Text size="sm" lineClamp={1}>
														{release.message}
													</Text>
												</Group>
												<Text size="xs" c="dimmed">
													{release.author}
												</Text>
											</Stack>
										</Table.Td>
										<Table.Td>{builder ? i18n._(builder.label) : "—"}</Table.Td>
										<Table.Td>
											<StatusBadge
												meta={
													release.live
														? liveReleaseStatus
														: releaseStatuses[release.status]
												}
											/>
										</Table.Td>
										<Table.Td>
											<Stack gap={0}>
												<Text size="sm">
													<LocalDate value={release.createdAt} />
												</Text>
												{release.buildDurationMs !== null && (
													<Text size="xs" c="dimmed">
														{formatDuration(
															i18n.locale,
															release.buildDurationMs,
														)}
													</Text>
												)}
											</Stack>
										</Table.Td>
										<Table.Td>
											<Group gap="xs" justify="flex-end" wrap="nowrap">
												{release.buildDeploymentId && (
													<Button
														size="xs"
														variant="subtle"
														onClick={() =>
															jobs.openJob(
																release.buildDeploymentId as string,
																deployTitle,
															)
														}
													>
														{i18n._("Build log")}
													</Button>
												)}
												{release.rollbackable && can("app.deploy") && (
													<Button
														size="xs"
														variant="light"
														leftSection={<RotateCcw size={14} />}
														onClick={() => confirmRollback(release)}
													>
														{i18n._("Roll back to this")}
													</Button>
												)}
											</Group>
										</Table.Td>
									</Table.Tr>
								);
							})}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}
		</SectionCard>
	);
};
