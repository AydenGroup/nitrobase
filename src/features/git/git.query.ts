import { queryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import { getGitAppFn, listDeliveriesFn, listReleasesFn } from "./git.functions";

export const gitAppQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "git"],
		queryFn: async () => await getGitAppFn({ data: appId }),
		staleTime: STALE_MS.short,
	});

export const releasesQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "git", "releases"],
		queryFn: async () => await listReleasesFn({ data: appId }),
		staleTime: STALE_MS.live,
	});

export const deliveriesQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "git", "deliveries"],
		queryFn: async () => await listDeliveriesFn({ data: appId }),
		staleTime: STALE_MS.live,
	});
