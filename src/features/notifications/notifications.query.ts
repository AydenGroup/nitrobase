import { queryOptions } from "@tanstack/react-query";
import { POLL_MS, STALE_MS } from "#/config/polling.ts";
import { listChannelsFn, listDeliveriesFn } from "./notifications.functions";

export const channelsQueryOptions = queryOptions({
	queryKey: ["notifications", "channels"],
	queryFn: async () => await listChannelsFn(),
	staleTime: STALE_MS.default,
});

export const deliveriesQueryOptions = (channelId?: string) =>
	queryOptions({
		queryKey: ["notifications", "deliveries", channelId ?? "all"],
		queryFn: async () => await listDeliveriesFn({ data: { channelId } }),
		staleTime: STALE_MS.live,
		refetchInterval: POLL_MS.background,
	});
