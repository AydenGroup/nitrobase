import { queryOptions } from "@tanstack/react-query";
import { POLL_MS, STALE_MS } from "#/config/polling.ts";
import {
	getAppHistoryFn,
	getServerHistoryFn,
	listAlertsFn,
} from "./monitoring.functions";
import type { AlertListInput, MetricRange } from "./schema";

export const serverHistoryQueryOptions = (
	serverId: string,
	range: MetricRange,
) =>
	queryOptions({
		queryKey: ["monitoring", "server", serverId, range],
		queryFn: async () =>
			await getServerHistoryFn({ data: { serverId, range } }),
		staleTime: STALE_MS.medium,
		refetchInterval: POLL_MS.history,
	});

export const appHistoryQueryOptions = (appId: string, range: MetricRange) =>
	queryOptions({
		queryKey: ["monitoring", "app", appId, range],
		queryFn: async () => await getAppHistoryFn({ data: { appId, range } }),
		staleTime: STALE_MS.medium,
		refetchInterval: POLL_MS.history,
	});

export const alertsQueryOptions = (input: AlertListInput = {}) =>
	queryOptions({
		queryKey: ["monitoring", "alerts", input],
		queryFn: async () => await listAlertsFn({ data: input }),
		staleTime: STALE_MS.default,
		refetchInterval: POLL_MS.alerts,
	});
