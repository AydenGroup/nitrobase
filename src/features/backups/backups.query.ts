import { queryOptions } from "@tanstack/react-query";
import type { BACKUP_KINDS, BACKUP_STATUSES } from "#/config/enums.ts";
import { STALE_MS } from "#/config/polling.ts";
import {
	getAppBackupSummaryFn,
	getAppPolicyFn,
	getPanelPolicyFn,
	getSchedulerClockFn,
	listBackupsFn,
	listDestinationsFn,
} from "./backups.functions";

export const destinationsQueryOptions = queryOptions({
	queryKey: ["backup-destinations"],
	queryFn: async () => await listDestinationsFn(),
	staleTime: STALE_MS.default,
});

export interface BackupFilters {
	appId?: string;
	destinationId?: string;
	status?: (typeof BACKUP_STATUSES)[number];
	kind?: (typeof BACKUP_KINDS)[number];
}

export const backupsQueryOptions = (filters: BackupFilters = {}) =>
	queryOptions({
		queryKey: ["backups", filters],
		queryFn: async () => await listBackupsFn({ data: filters }),
		staleTime: STALE_MS.live,
	});

export const appPolicyQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "backup-policy"],
		queryFn: async () => await getAppPolicyFn({ data: appId }),
		staleTime: STALE_MS.default,
	});

export const panelPolicyQueryOptions = queryOptions({
	queryKey: ["backup-panel-policy"],
	queryFn: async () => await getPanelPolicyFn(),
	staleTime: STALE_MS.default,
});

export const appBackupSummaryQueryOptions = (appId: string) =>
	queryOptions({
		queryKey: ["apps", appId, "backup-summary"],
		queryFn: async () => await getAppBackupSummaryFn({ data: appId }),
		staleTime: STALE_MS.short,
	});

export const schedulerClockQueryOptions = queryOptions({
	queryKey: ["scheduler-clock"],
	queryFn: async () => await getSchedulerClockFn(),
	staleTime: STALE_MS.rare,
});
