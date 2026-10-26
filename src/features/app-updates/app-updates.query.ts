import { queryOptions } from "@tanstack/react-query";
import { UPDATE_POLLING } from "#/config/polling.ts";
import {
	getAutoUpdateWindowFn,
	getUpdateBatchFn,
	listAppUpdatesFn,
} from "./app-updates.functions";

export const appUpdatesQueryOptions = queryOptions({
	queryKey: ["app-updates"],
	queryFn: async () => await listAppUpdatesFn(),
	staleTime: UPDATE_POLLING.appUpdatesStaleMs,
});

export const autoUpdateWindowQueryOptions = queryOptions({
	queryKey: ["app-updates", "window"],
	queryFn: async () => await getAutoUpdateWindowFn(),
	staleTime: UPDATE_POLLING.windowStaleMs,
});

export const updateBatchQueryOptions = (id: string) =>
	queryOptions({
		queryKey: ["app-updates", "batch", id],
		queryFn: async () => await getUpdateBatchFn({ data: id }),
		refetchInterval: (query) =>
			query.state.data?.finishedAt ? false : UPDATE_POLLING.batchRefetchMs,
	});
