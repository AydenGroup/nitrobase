import { queryOptions } from "@tanstack/react-query";
import { POLL_MS, STALE_MS } from "#/config/polling.ts";
import { getDashboardFn } from "./dashboard.functions";

export const dashboardQueryOptions = queryOptions({
	queryKey: ["dashboard"],
	queryFn: async () => await getDashboardFn(),
	staleTime: STALE_MS.short,
	refetchInterval: POLL_MS.background,
});
