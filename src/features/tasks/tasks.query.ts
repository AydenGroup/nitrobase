import { queryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import { listTaskRunsFn, listTasksFn } from "./tasks.functions";

export const appTasksQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "tasks"],
		queryFn: async () => await listTasksFn({ data: appId }),
		staleTime: STALE_MS.short,
	});

export const taskRunsQueryOptions = (appId: string, taskId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "tasks", taskId, "runs"],
		queryFn: async () => await listTaskRunsFn({ data: { appId, id: taskId } }),
		staleTime: STALE_MS.live,
	});
