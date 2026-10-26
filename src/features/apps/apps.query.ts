import { queryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import {
	getAppEnvFn,
	getAppFn,
	getDeployDefaultsFn,
	getServiceEnvFn,
	listAllDomainsFn,
	listAppDeploymentsFn,
	listAppsFn,
} from "./apps.functions";

/** Instance defaults of the deploy forms (env: changes with a restart only). */
export const deployDefaultsQueryOptions = queryOptions({
	queryKey: ["apps", "deploy-defaults"],
	queryFn: async () => await getDeployDefaultsFn(),
	staleTime: STALE_MS.static,
});

export const appsQueryOptions = queryOptions({
	queryKey: ["apps"],
	queryFn: async () => await listAppsFn(),
	staleTime: STALE_MS.default,
});

export const appQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId],
		queryFn: async () => await getAppFn({ data: appId }),
		staleTime: STALE_MS.short,
	});

export const appDeploymentsQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "deployments"],
		queryFn: async () => await listAppDeploymentsFn({ data: appId }),
		staleTime: STALE_MS.short,
	});

export const appEnvQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "env"],
		queryFn: async () => await getAppEnvFn({ data: appId }),
		staleTime: 0,
	});

export const allDomainsQueryOptions = queryOptions({
	queryKey: ["domains"],
	queryFn: async () => await listAllDomainsFn(),
	staleTime: STALE_MS.default,
});

export const serviceEnvQueryOptions = (appId: string, service: string) =>
	queryOptions({
		queryKey: ["apps", appId, "service-env", service],
		queryFn: async () => await getServiceEnvFn({ data: { appId, service } }),
		staleTime: 0,
	});
