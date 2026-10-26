import { queryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import { listAppSyncsFn, listCloudConnectionsFn } from "./cloud-sync.functions";

export const cloudConnectionsQueryOptions = queryOptions({
	queryKey: ["cloud-connections"],
	queryFn: async () => await listCloudConnectionsFn(),
	staleTime: STALE_MS.default,
});

export const appSyncsQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "cloud-syncs"],
		queryFn: async () => await listAppSyncsFn({ data: { appId } }),
		staleTime: STALE_MS.live,
	});
