import { queryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import {
	databaseSizeFn,
	getDatabaseFn,
	listAppDatabaseLinksFn,
	listDatabasesFn,
	listDatabaseUsersFn,
} from "./databases.functions";

export const databasesQueryOptions = () =>
	queryOptions({
		queryKey: ["databases"],
		queryFn: async () => await listDatabasesFn(),
		staleTime: STALE_MS.short,
	});

export const databaseQueryOptions = (id: string) =>
	queryOptions({
		queryKey: ["databases", id],
		queryFn: async () => await getDatabaseFn({ data: id }),
		staleTime: STALE_MS.live,
	});

/** Measured size (cached server side). */
export const databaseSizeQueryOptions = (id: string) =>
	queryOptions({
		queryKey: ["databases", id, "size"],
		queryFn: async () => await databaseSizeFn({ data: id }),
		staleTime: STALE_MS.long,
	});

export const databaseUsersQueryOptions = (id: string) =>
	queryOptions({
		queryKey: ["databases", id, "users"],
		queryFn: async () => await listDatabaseUsersFn({ data: id }),
		staleTime: STALE_MS.live,
	});

/** Databases an app is linked to. */
export const appDatabaseLinksQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "database-links"],
		queryFn: async () => await listAppDatabaseLinksFn({ data: appId }),
		staleTime: STALE_MS.live,
	});
