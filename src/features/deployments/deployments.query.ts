import { queryOptions } from "@tanstack/react-query";
import { pollWhile, STALE_MS } from "#/config/polling.ts";
import { deploymentStatuses, isBusy } from "#/config/status.ts";
import { listJobsFn } from "./deployments.functions";
import type { JobFilters } from "./schema";

export const jobsQueryOptions = (filters: Partial<JobFilters> = {}) =>
	queryOptions({
		queryKey: ["jobs", filters],
		queryFn: async () => await listJobsFn({ data: filters }),
		staleTime: STALE_MS.live,
		refetchInterval: (query) =>
			pollWhile(
				!!query.state.data?.some((job) =>
					isBusy(deploymentStatuses, job.status),
				),
			),
	});
