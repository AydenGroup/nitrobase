import { queryOptions } from "@tanstack/react-query";
import { apiBaseUrlFn, listApiTokensFn } from "./tokens.functions";

export const apiTokensQueryOptions = queryOptions({
	queryKey: ["api-tokens"],
	queryFn: async () => await listApiTokensFn(),
});

/** Configured once per process: fetched once. */
export const apiBaseUrlQueryOptions = queryOptions({
	queryKey: ["api-base-url"],
	queryFn: async () => await apiBaseUrlFn(),
	staleTime: Number.POSITIVE_INFINITY,
});
