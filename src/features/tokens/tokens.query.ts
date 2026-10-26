import { queryOptions } from "@tanstack/react-query";
import { listApiTokensFn } from "./tokens.functions";

export const apiTokensQueryOptions = queryOptions({
	queryKey: ["api-tokens"],
	queryFn: async () => await listApiTokensFn(),
});
