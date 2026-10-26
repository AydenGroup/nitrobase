import { queryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import { getTwoFactorStatusFn, listSessionsFn } from "./security.functions";

export const twoFactorStatusQueryOptions = queryOptions({
	queryKey: ["security", "2fa"],
	queryFn: async () => await getTwoFactorStatusFn(),
	staleTime: STALE_MS.medium,
});

export const sessionsQueryOptions = queryOptions({
	queryKey: ["security", "sessions"],
	queryFn: async () => await listSessionsFn(),
	staleTime: STALE_MS.default,
});
