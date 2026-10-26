import { useLingui } from "@lingui/react";
import { Button, Card, Group, Select, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { useAppJob } from "#/components/apps/useAppJob";
import { BackupFirstCheckbox } from "#/components/backups/BackupFirstCheckbox";
import { databaseEngine } from "#/config/database-engines.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import { upgradeDatabaseFn } from "#/features/databases/databases.functions.ts";
import { databaseQueryOptions } from "#/features/databases/databases.query.ts";

/**
 * Database version (Settings): newer versions of the same line only (a
 * new major needs a dump and restore into a new database); backup first.
 */
export const DatabaseVersionCard: React.FC<{
	overview: AppOverview;
	jobs: ReturnType<typeof useAppJob>;
}> = ({ overview, jobs }) => {
	const { i18n } = useLingui();
	const { data } = useQuery(databaseQueryOptions(overview.app.id));
	const [version, setVersion] = useState<string | null>(null);
	const [backupFirst, setBackupFirst] = useState(true);
	if (!data) return null;
	const engine = databaseEngine(data.engine);
	return (
		<Card withBorder p="md">
			<Title order={5} mb="xs">
				{i18n._("Version")}
			</Title>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					{i18n._("Current: {version}", {
						version: `${engine.name} ${data.tag}`,
					})}
				</Text>
				{data.upgradeTargets.length === 0 ? (
					<Text size="sm" c="dimmed">
						{engine.upgrade === "patch"
							? i18n._(
									"No newer version of this line is offered yet. A new major version can't be applied in place: back up, then restore the backup as a new database at the newer version.",
								)
							: i18n._("This is the newest version offered.")}
					</Text>
				) : (
					<>
						<Group align="flex-end">
							<Select
								label={i18n._("Move to")}
								data={data.upgradeTargets}
								value={version}
								onChange={setVersion}
								w={220}
							/>
						</Group>
						<BackupFirstCheckbox
							appId={overview.app.id}
							checked={backupFirst}
							onChange={setBackupFirst}
						/>
						<Group justify="flex-end">
							<Button
								disabled={!version}
								loading={jobs.isStarting}
								onClick={() =>
									version &&
									jobs.startJob({
										title: i18n._("Change version"),
										start: () =>
											upgradeDatabaseFn({
												data: {
													databaseId: overview.app.id,
													version,
													backupFirst,
												},
											}),
									})
								}
							>
								{i18n._("Change version")}
							</Button>
						</Group>
					</>
				)}
			</Stack>
		</Card>
	);
};
