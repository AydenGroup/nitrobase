import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { BACKUP_KINDS, BACKUP_STATUSES } from "#/config/enums.ts";
import type { CodedParams } from "#/libs/coded.ts";
import { apps } from "./apps";
import { servers } from "./server";
import { teams } from "./teams";
import { users } from "./user";

/** Steps of a destination test, in order (labels: `destinationTestSteps`). */
export const DESTINATION_TEST_STEPS = ["write", "read", "delete"] as const;
export type DestinationTestStep = (typeof DESTINATION_TEST_STEPS)[number];

export interface DestinationTestRecord {
	ok: boolean;
	steps: { step: DestinationTestStep; ok: boolean }[];
	/** Failure class (UI label) and the distinct rclone lines. */
	kind: string | null;
	detail: string | null;
	serverName: string;
	at: string;
}

// Where archives go. Type = destination driver id (#/server/services/backup/drivers).
export const backupDestinations = pgTable(
	"backup_destinations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		/** Owning team (access is checked against the caller's team). */
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		/** Member who added it (kept when the member leaves). */
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		type: text("type").notNull(),
		/** Encrypted JSON of the driver config (credentials included). */
		configEncrypted: text("config_encrypted").notNull(),
		/** Result of the last "Test" (redacted; no secrets). */
		lastTest: jsonb("last_test").$type<DestinationTestRecord>(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [index("backup_destinations_team_id_idx").on(table.teamId)],
);

export const backupTargetEnum = pgEnum("backup_target", ["app", "panel"]);

// Scheduled backups: one policy per app, plus the Nitrobase self-backup.
export const backupPolicies = pgTable(
	"backup_policies",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		/** Owning team (access is checked against the caller's team). */
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		/** Member who last saved it; scheduled runs act for the team (kept when the member leaves). */
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		target: backupTargetEnum("target").default("app").notNull(),
		appId: uuid("app_id").references(() => apps.id, { onDelete: "cascade" }),
		/** Self-backup: the server whose rclone uploads the panel dump. */
		serverId: uuid("server_id").references(() => servers.id, {
			onDelete: "cascade",
		}),
		destinationId: uuid("destination_id")
			.notNull()
			.references(() => backupDestinations.id, { onDelete: "restrict" }),
		cron: text("cron").notNull(),
		/** Keep the newest N successful backups (null: no count rule). */
		keepLast: integer("keep_last"),
		/** Keep backups younger than N days (null: no age rule). */
		keepDays: integer("keep_days"),
		/** Retention also prunes this app's manual backups on the same destination. */
		includeManual: boolean("include_manual").default(false).notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		lastRunAt: timestamp("last_run_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("backup_policies_app_id_idx").on(table.appId),
		index("backup_policies_team_id_idx").on(table.teamId),
	],
);

export const backupKindEnum = pgEnum("backup_kind", BACKUP_KINDS);
/** `corrupt`: the archive failed verification (checksum/manifest): never restore it. */
export const backupStatusEnum = pgEnum("backup_status", BACKUP_STATUSES);
export const backupTriggerEnum = pgEnum("backup_trigger", [
	"manual",
	"schedule",
]);

// One archive per row. App identity is snapshotted so backups outlive the app.
export const backups = pgTable(
	"backups",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		/** Owning team (access is checked against the caller's team). */
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		/** Member who started it (kept when the member leaves). */
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		appId: uuid("app_id").references(() => apps.id, { onDelete: "set null" }),
		/** Server that built (and, for `local`, stores) the archive. */
		serverId: uuid("server_id").references(() => servers.id, {
			onDelete: "set null",
		}),
		destinationId: uuid("destination_id")
			.notNull()
			.references(() => backupDestinations.id, { onDelete: "restrict" }),
		policyId: uuid("policy_id").references(() => backupPolicies.id, {
			onDelete: "set null",
		}),
		deploymentId: uuid("deployment_id"),
		kind: backupKindEnum("kind").notNull(),
		status: backupStatusEnum("status").default("running").notNull(),
		trigger: backupTriggerEnum("trigger").default("manual").notNull(),
		appName: text("app_name"),
		templateId: text("template_id"),
		folder: text("folder"),
		version: text("version"),
		commitSha: text("commit_sha"),
		/**
		 * Custom-compose apps: their encrypted compose spec at backup time
		 * (as on `apps`), so "restore as a new app" works after the app is
		 * deleted. The archive's env.enc carries it too; this copy is needed
		 * before the archive is downloaded (routes and domains of the new app).
		 */
		customSpecEncrypted: text("custom_spec_encrypted"),
		/** Path inside the destination. */
		path: text("path"),
		sizeBytes: bigint("size_bytes", { mode: "number" }),
		/** sha256 of the archive file. */
		checksum: text("checksum"),
		durationMs: integer("duration_ms"),
		error: text("error"),
		/** Coded form of the error (see `ErrorInfo` in #/libs/coded.ts). */
		errorCode: text("error_code"),
		errorParams: jsonb("error_params").$type<CodedParams>(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		finishedAt: timestamp("finished_at"),
		/** Last successful "Verify" (download + sha256 + manifest). */
		verifiedAt: timestamp("verified_at"),
	},
	(table) => [
		index("backups_team_id_idx").on(table.teamId),
		index("backups_app_id_idx").on(table.appId),
		index("backups_destination_id_idx").on(table.destinationId),
	],
);
