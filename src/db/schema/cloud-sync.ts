import {
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type { ConnectionTestStep, SyncDirection } from "#/config/cloud-sync.ts";
import type { CodedParams, ErrorInfo } from "#/libs/coded.ts";
import { apps } from "./apps";
import { deployments } from "./server";
import { teams } from "./teams";
import { users } from "./user";

/** Result of a connection "Test" (no secrets). */
export interface CloudConnectionTestRecord {
	ok: boolean;
	steps: {
		step: ConnectionTestStep;
		ok: boolean;
		/** Skipped: nothing to test (e.g. no S3 keys). */
		skipped?: boolean;
		error?: ErrorInfo | null;
	}[];
	/** What the provider reported (project name, region, Postgres version). */
	info: Record<string, string>;
	/** Coded notes (e.g. the TLS certificate was not verified). */
	warnings: ErrorInfo[];
	/**
	 * What the credentials allow per direction (e.g. read but not write:
	 * export refused, with the reason).
	 */
	directions: {
		direction: SyncDirection;
		ok: boolean;
		reason?: ErrorInfo | null;
	}[];
	at: string;
}

// Credentials of a hosted project (#/config/cloud-sync.ts providers).
export const cloudConnections = pgTable(
	"cloud_connections",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		/** Member who added it (kept when the member leaves). */
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		/** Provider id (`cloudSyncProviders`). */
		provider: text("provider").notNull(),
		/** Encrypted JSON of the provider config (credentials included). */
		configEncrypted: text("config_encrypted").notNull(),
		lastTest: jsonb("last_test").$type<CloudConnectionTestRecord>(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [index("cloud_connections_team_id_idx").on(table.teamId)],
);

/** What a finished sync reports (row counts, files, functions, warnings). */
export interface CloudSyncSummary {
	tables?: { table: string; source: number; target: number }[];
	buckets?: { bucket: string; source: number; target: number }[];
	functions?: { slug: string; ok: boolean }[];
	/**
	 * Resources a provider-run migration copied (e.g. Appwrite's
	 * `statusCounters`), against the cloud's counts (null: not counted).
	 */
	resources?: {
		resource: string;
		source: number | null;
		target: number;
		errors: number;
	}[];
	warnings?: { code: string; params: CodedParams }[];
	/** Coded notes for the owner (e.g. where the console login is). */
	notes?: { code: string; params: CodedParams }[];
}

// One import/export between a cloud project and an app (history + origin).
export const cloudSyncs = pgTable(
	"cloud_syncs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		appId: uuid("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		/** Kept as null when the connection is deleted (history stays). */
		connectionId: uuid("connection_id").references(() => cloudConnections.id, {
			onDelete: "set null",
		}),
		/** Connection name at the time (shown after it is deleted). */
		connectionName: text("connection_name").notNull(),
		provider: text("provider").notNull(),
		/** "import" | "export". */
		direction: text("direction").notNull(),
		/** The cloud project (e.g. a Supabase project reference). */
		project: text("project").notNull(),
		parts: jsonb("parts").$type<string[]>().notNull(),
		deploymentId: uuid("deployment_id").references(() => deployments.id, {
			onDelete: "set null",
		}),
		/** "running" | "success" | "failed". */
		status: text("status").notNull().default("running"),
		summary: jsonb("summary").$type<CloudSyncSummary>(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		finishedAt: timestamp("finished_at"),
	},
	(table) => [
		index("cloud_syncs_team_id_idx").on(table.teamId),
		index("cloud_syncs_app_id_idx").on(table.appId),
		index("cloud_syncs_connection_id_idx").on(table.connectionId),
		index("cloud_syncs_deployment_id_idx").on(table.deploymentId),
	],
);
