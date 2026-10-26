import { queryOptions } from "@tanstack/react-query";
import { UPDATE_POLLING } from "#/config/polling.ts";
import { getInstanceUpdateFn, getUpgradeOverviewFn } from "./upgrade.functions";

export const upgradeOverviewQueryOptions = queryOptions({
	queryKey: ["upgrade", "overview"],
	queryFn: async () => await getUpgradeOverviewFn({ data: {} }),
	staleTime: UPDATE_POLLING.upgradeOverviewStaleMs,
});

export const instanceUpdateQueryOptions = queryOptions({
	queryKey: ["upgrade", "release"],
	queryFn: async () => await getInstanceUpdateFn(),
	staleTime: UPDATE_POLLING.releaseStaleMs,
});
