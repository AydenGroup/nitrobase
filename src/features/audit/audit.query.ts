import { infiniteQueryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import { listAuditEventsFn } from "./audit.functions";
import type { AuditListInput } from "./schema";

export const auditQueryOptions = (filters: Omit<AuditListInput, "before">) =>
	infiniteQueryOptions({
		queryKey: ["audit", filters],
		queryFn: async ({ pageParam }) =>
			await listAuditEventsFn({
				data: { ...filters, before: pageParam ?? undefined },
			}),
		initialPageParam: null as number | null,
		getNextPageParam: (page) => page.nextBefore,
		staleTime: STALE_MS.short,
	});
