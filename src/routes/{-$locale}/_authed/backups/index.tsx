import { useLingui } from "@lingui/react";
import { Group, Select, Stack } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { BackupsTable } from "#/components/backups/BackupsTable";
import { PanelBackupCard } from "#/components/backups/PanelBackupCard";
import { useCan } from "#/components/teams/useCan";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import { BACKUP_STATUSES } from "#/config/enums.ts";
import { pollWhile } from "#/config/polling.ts";
import { APP_NAME } from "#/config/shared.ts";
import { backupStatuses, isBusy } from "#/config/status.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import {
	backupsQueryOptions,
	destinationsQueryOptions,
} from "#/features/backups/backups.query.ts";

const SearchSchema = z.object({
	appId: z.string().optional(),
	destinationId: z.string().optional(),
	status: z.enum(BACKUP_STATUSES).optional(),
});

export const Route = createFileRoute("/{-$locale}/_authed/backups/")({
	validateSearch: SearchSchema,
	loader: ({ context }) => ({ crumb: context.i18n._("Backups") }),
	component: Backups,
});

function Backups() {
	const { i18n } = useLingui();
	const can = useCan();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const filters = {
		appId: z.guid().safeParse(search.appId).success ? search.appId : undefined,
		destinationId: z.guid().safeParse(search.destinationId).success
			? search.destinationId
			: undefined,
		status: search.status,
	};
	const backups = useQuery({
		...backupsQueryOptions(filters),
		refetchInterval: (query) =>
			pollWhile(
				!!query.state.data?.some((row) => isBusy(backupStatuses, row.status)),
			),
	});
	const { data: apps = [] } = useQuery(appsQueryOptions);
	const { data: destinations = [] } = useQuery(destinationsQueryOptions);
	const setFilter = (key: keyof typeof search, value: string | null) =>
		navigate({
			search: (prev) => ({ ...prev, [key]: value ?? undefined }),
			replace: true,
		});

	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Backups")}
				description={i18n._(
					"Every app backup and {appName} backup, with download and restore.",
					{ appName: APP_NAME },
				)}
			/>
			<Group gap="sm" wrap="wrap">
				<Select
					placeholder={i18n._("All apps")}
					data={apps.map((app) => ({ value: app.id, label: app.name }))}
					value={filters.appId ?? null}
					onChange={(value) => setFilter("appId", value)}
					clearable
					searchable
					w={200}
				/>
				<Select
					placeholder={i18n._("All destinations")}
					data={destinations.map((item) => ({
						value: item.id,
						label: item.name,
					}))}
					value={filters.destinationId ?? null}
					onChange={(value) => setFilter("destinationId", value)}
					clearable
					w={200}
				/>
				<Select
					placeholder={i18n._("All statuses")}
					data={Object.entries(backupStatuses).map(([value, meta]) => ({
						value,
						label: i18n._(meta.label),
					}))}
					value={filters.status ?? null}
					onChange={(value) => setFilter("status", value)}
					clearable
					w={160}
				/>
			</Group>
			<SectionCard flush>
				<BackupsTable
					backups={backups.data ?? []}
					loading={backups.isLoading}
				/>
			</SectionCard>
			{can("instance.manage") && <PanelBackupCard />}
		</Stack>
	);
}
