import { queryOptions } from "@tanstack/react-query";
import { POLL_MS, STALE_MS } from "#/config/polling.ts";
import {
	getServerFn,
	listServerSummariesFn,
	listServersFn,
} from "./servers.functions";

// Keys are nested under ["servers"], so invalidating `serversQueryOptions`
// also refreshes every per-server query.

export const serversQueryOptions = queryOptions({
	queryKey: ["servers"],
	queryFn: async () => await listServersFn(),
	staleTime: STALE_MS.medium,
});

/** App counts and latest CPU/RAM/disk per server (server list). */
export const serverSummariesQueryOptions = queryOptions({
	queryKey: ["servers", "summaries"],
	queryFn: async () => await listServerSummariesFn(),
	staleTime: STALE_MS.default,
	refetchInterval: POLL_MS.background,
});

/** One server; resolves to null when missing, not owned or not a uuid. */
export const serverQueryOptions = (serverId: string) =>
	queryOptions({
		queryKey: ["servers", serverId],
		queryFn: async () => await getServerFn({ data: serverId }),
		staleTime: STALE_MS.medium,
	});
