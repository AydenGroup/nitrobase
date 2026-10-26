import { queryOptions } from "@tanstack/react-query";
import { SESSION_GC_MS, STALE_MS } from "#/config/polling.ts";
import { getCurrentUserFn, isInitialSetupCompleteFn } from "./auth.functions";

export const userQueryOptions = queryOptions({
	queryKey: ["user"],
	queryFn: async () => await getCurrentUserFn(),
	staleTime: STALE_MS.static,
	gcTime: SESSION_GC_MS,
});

export const initialUserQueryOptions = queryOptions({
	queryKey: ["initialUser"],
	queryFn: async () => await isInitialSetupCompleteFn(),
	staleTime: STALE_MS.static,
	gcTime: SESSION_GC_MS,
});
