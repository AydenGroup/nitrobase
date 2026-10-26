import { queryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import {
	getEdgeFunctionFn,
	getSharedFolderFn,
	getSupabaseOverviewFn,
	listDbFunctionsFn,
	listDbSchemasFn,
	listEdgeFunctionsFn,
	listSharedFoldersFn,
} from "./supabase.functions";

export const supabaseOverviewQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "supabase", "overview"],
		queryFn: async () => await getSupabaseOverviewFn({ data: { appId } }),
		staleTime: STALE_MS.short,
	});

export const edgeFunctionsQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "supabase", "functions"],
		queryFn: async () => await listEdgeFunctionsFn({ data: { appId } }),
		staleTime: STALE_MS.short,
	});

export const edgeFunctionQueryOptions = (appId: string, name: string) =>
	queryOptions({
		queryKey: ["apps", appId, "supabase", "functions", name],
		queryFn: async () => await getEdgeFunctionFn({ data: { appId, name } }),
		staleTime: 0,
	});

export const sharedFoldersQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "supabase", "shared"],
		queryFn: async () => await listSharedFoldersFn({ data: { appId } }),
		staleTime: STALE_MS.short,
	});

export const sharedFolderQueryOptions = (appId: string, name: string) =>
	queryOptions({
		queryKey: ["apps", appId, "supabase", "shared", name],
		queryFn: async () => await getSharedFolderFn({ data: { appId, name } }),
		staleTime: 0,
	});

export const dbSchemasQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "supabase", "schemas"],
		queryFn: async () => await listDbSchemasFn({ data: { appId } }),
		staleTime: STALE_MS.medium,
	});

export const dbFunctionsQueryOptions = (appId: string, schema: string) =>
	queryOptions({
		queryKey: ["apps", appId, "supabase", "db-functions", schema],
		queryFn: async () => await listDbFunctionsFn({ data: { appId, schema } }),
		staleTime: STALE_MS.short,
	});
