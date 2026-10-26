import { z } from "zod";
import type { ErrorInfo } from "#/libs/coded.ts";
import {
	APP_UPDATE_POLICIES,
	type AppUpdateKind,
	type AppUpdatePolicy,
	type AppUpdateResult,
	type RollbackMode,
} from "#/server/services/app-updates/policy.ts";

export type { AppUpdateKind, AppUpdatePolicy, AppUpdateResult, RollbackMode };

/** Update state of one app as the UI shows it. */
export interface AppUpdateView {
	appId: string;
	policy: AppUpdatePolicy;
	/** The app's source offers versions (template, database, git). */
	supported: boolean;
	/** A newer version is known. */
	available: boolean;
	/** Deployed version label (template ref, `engine@tag`, branch commit). */
	current: string;
	version: string | null;
	name: string | null;
	url: string | null;
	kind: AppUpdateKind | null;
	/** How a failed update is undone for this app. */
	rollback: RollbackMode;
	checkedAt: string | null;
	checkError: ErrorInfo | null;
	lastResult: AppUpdateResult | null;
	lastResultAt: string | null;
	lastDeploymentId: string | null;
}

/** Maintenance window of automatic updates (config, shown with policies). */
export interface AutoUpdateWindow {
	cron: string;
	minutes: number;
	/** Next start, ISO. */
	nextStart: string | null;
	timeZone: string;
}

export const UpdatePolicySchema = z.object({
	appId: z.guid(),
	policy: z.enum(APP_UPDATE_POLICIES),
});

export const UpdateAppSchema = z.object({
	appId: z.guid(),
	/** Defaults to the newest known version. */
	version: z
		.string()
		.max(200)
		.regex(/^[\w][\w./@-]*$/)
		.optional(),
	backupFirst: z.boolean().default(true),
});

export const BulkUpdateSchema = z.object({
	appIds: z.array(z.guid()).min(1).max(500),
	backupFirst: z.boolean().default(true),
});

export type BatchItemStatus = "queued" | "running" | AppUpdateResult;

export interface UpdateBatchView {
	id: string;
	trigger: "bulk" | "auto";
	createdAt: string;
	finishedAt: string | null;
	items: {
		appId: string;
		appName: string;
		serverName: string;
		from: string;
		to: string;
		status: BatchItemStatus;
		deploymentId: string | null;
		error: ErrorInfo | null;
	}[];
}
