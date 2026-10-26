import { useQuery } from "@tanstack/react-query";
import { deployDefaultsQueryOptions } from "#/features/apps/apps.query.ts";

/**
 * Name of the instance's free wildcard-DNS provider (FREE_DOMAIN_PROVIDER)
 * for texts that mention it; empty until loaded.
 */
export function useFreeDomainProvider(): string {
	return useQuery(deployDefaultsQueryOptions).data?.freeDomainProvider ?? "";
}
