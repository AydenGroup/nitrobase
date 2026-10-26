import { useLingui } from "@lingui/react";
import { Select, Stack } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { JobsTable } from "#/components/jobs/JobsTable";
import { FilterBar } from "#/components/ui/FilterBar";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import { DEPLOYMENT_STATUSES } from "#/config/enums.ts";
import { deploymentStatuses, jobTypes } from "#/config/status.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import { jobsQueryOptions } from "#/features/deployments/deployments.query.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";

const SearchSchema = z.object({
	type: z.string().optional(),
	status: z.enum(DEPLOYMENT_STATUSES).optional(),
	serverId: z.string().optional(),
	appId: z.string().optional(),
});

export const Route = createFileRoute("/{-$locale}/_authed/jobs/")({
	validateSearch: SearchSchema,
	loader: ({ context }) => ({ crumb: context.i18n._("Jobs") }),
	component: Jobs,
});

function Jobs() {
	const { i18n } = useLingui();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const {
		data: jobs = [],
		isLoading,
		refetch,
	} = useQuery(jobsQueryOptions(search));
	const { data: servers = [] } = useQuery(serversQueryOptions);
	const { data: apps = [] } = useQuery(appsQueryOptions);
	const setFilter = (key: keyof typeof search, value: string | null) =>
		navigate({
			search: (prev) => ({ ...prev, [key]: value ?? undefined }),
			replace: true,
		});

	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Jobs")}
				description={i18n._("Every bootstrap, deploy and maintenance job")}
			/>
			<FilterBar
				activeCount={
					[search.type, search.status, search.serverId, search.appId].filter(
						Boolean,
					).length
				}
				onClear={() => navigate({ search: {}, replace: true })}
			>
				{(stacked) => (
					<>
						<Select
							placeholder={i18n._("All kinds")}
							data={Object.entries(jobTypes).map(([value, label]) => ({
								value,
								label: i18n._(label),
							}))}
							value={search.type ?? null}
							onChange={(value) => setFilter("type", value)}
							clearable
							w={stacked ? undefined : 200}
						/>
						<Select
							placeholder={i18n._("All statuses")}
							data={Object.entries(deploymentStatuses).map(([value, meta]) => ({
								value,
								label: i18n._(meta.label),
							}))}
							value={search.status ?? null}
							onChange={(value) => setFilter("status", value)}
							clearable
							w={stacked ? undefined : 160}
						/>
						<Select
							placeholder={i18n._("All servers")}
							data={servers.map((server) => ({
								value: server.id,
								label: server.name,
							}))}
							value={search.serverId ?? null}
							onChange={(value) => setFilter("serverId", value)}
							clearable
							searchable
							w={stacked ? undefined : 200}
						/>
						<Select
							placeholder={i18n._("All apps")}
							data={apps.map((app) => ({ value: app.id, label: app.name }))}
							value={search.appId ?? null}
							onChange={(value) => setFilter("appId", value)}
							clearable
							searchable
							w={stacked ? undefined : 200}
						/>
					</>
				)}
			</FilterBar>
			<SectionCard flush>
				<JobsTable
					jobs={jobs}
					loading={isLoading}
					onCompleted={() => refetch()}
				/>
			</SectionCard>
		</Stack>
	);
}
