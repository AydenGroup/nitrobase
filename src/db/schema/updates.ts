import {
	index,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type { CodedParams } from "#/libs/coded.ts";
import type {
	AppUpdateKind,
	AppUpdateResult,
} from "#/server/services/app-updates/policy.ts";
import { APP_UPDATE_POLICIES } from "#/server/services/app-updates/policy.ts";
import { apps } from "./apps";
import { deployments } from "./server";

export const appUpdatePolicyEnum = pgEnum(
	"app_update_policy",
	APP_UPDATE_POLICIES,
);

/**
 * Update state of an app (R4 M4): the newest version its source offers
 * (scheduled check), the owner's policy, and the last update's result.
 * One row per app, created by the first check or policy change.
 */
export const appUpdates = pgTable(
	"app_updates",
	{
		appId: uuid("app_id")
			.primaryKey()
			.references(() => apps.id, { onDelete: "cascade" }),
		policy: appUpdatePolicyEnum("policy").default("notify").notNull(),
		/** Newer version (ref, `engine@tag` or commit SHA); null: up to date. */
		latestVersion: text("latest_version"),
		/** Display name (release name, `branch@sha`). */
		latestName: text("latest_name"),
		/** Release notes (https). */
		latestUrl: text("latest_url"),
		latestPublishedAt: timestamp("latest_published_at"),
		latestKind: text("latest_kind").$type<AppUpdateKind>(),
		checkedAt: timestamp("checked_at"),
		/** Last check error (short text); null when it worked. */
		checkError: text("check_error"),
		/** Coded form of the check error (see `ErrorInfo` in #/libs/coded.ts). */
		checkErrorCode: text("check_error_code"),
		checkErrorParams: jsonb("check_error_params").$type<CodedParams>(),
		/** `app.update_available` was sent for this version (dedupe). */
		notifiedVersion: text("notified_version"),
		/** An automatic update of this version was tried (no retry loops). */
		autoAttemptedVersion: text("auto_attempted_version"),
		lastResult: text("last_result").$type<AppUpdateResult>(),
		lastResultAt: timestamp("last_result_at"),
		lastDeploymentId: uuid("last_deployment_id").references(
			() => deployments.id,
			{ onDelete: "set null" },
		),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		index("app_updates_last_deployment_id_idx").on(table.lastDeploymentId),
	],
);
