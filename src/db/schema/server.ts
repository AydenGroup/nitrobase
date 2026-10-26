import { sql } from "drizzle-orm";
import {
	bigserial,
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
import { DEPLOYMENT_STATUSES } from "#/config/enums.ts";
import { DEFAULT_SSH_PORT } from "#/config/shared.ts";
import { SERVER_AUTH_METHODS } from "#/config/ssh-key-types.ts";
import type { CodedParams } from "#/libs/coded.ts";
import { sshKeys } from "./ssh-keys";
import { teams } from "./teams";
import { users } from "./user";

/**
 * Server lifecycle: `pending` (added, never tested) → `reachable` /
 * `unreachable` (connection test) → `bootstrapping` → `ready` or `error`.
 */
export const serverStatusEnum = pgEnum("server_status", [
	"pending",
	"unreachable",
	"reachable",
	"bootstrapping",
	"ready",
	"error",
]);

/** Status of a background job row in `deployments`. */
export const deploymentStatusEnum = pgEnum(
	"deployment_status",
	DEPLOYMENT_STATUSES,
);

export const serverAuthMethodEnum = pgEnum(
	"server_auth_method",
	SERVER_AUTH_METHODS,
);

// Servers - VPS instances managed by Nitrobase
export const servers = pgTable(
	"servers",
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
		host: text("host").notNull(),
		port: integer("port").default(DEFAULT_SSH_PORT).notNull(),
		username: text("username").notNull(),

		// Authentication (encrypted at rest)
		authMethod: serverAuthMethodEnum("auth_method").notNull(), // "password" | "private_key"
		passwordEncrypted: text("password_encrypted"),
		// Shared key from the user's key library; resolved at connect time.
		// NO ACTION (checked at statement end): deleting a key still in use
		// fails instead of silently leaving the server without credentials,
		// while deleting a user still cascades through keys and servers.
		sshKeyId: uuid("ssh_key_id").references(() => sshKeys.id, {
			onDelete: "no action",
		}),

		// SSH host key fingerprint (SHA256:...), trusted on first use
		hostKeyFingerprint: text("host_key_fingerprint"),

		// The machine Nitrobase itself runs on (created at registration):
		// commands run locally, host/port/credentials are placeholders and
		// it cannot be deleted.
		isDefault: boolean("is_default").default(false).notNull(),

		status: serverStatusEnum("status").default("pending").notNull(),

		// System info gathered during bootstrap
		os: text("os"),
		dockerVersion: text("docker_version"),
		traefikVersion: text("traefik_version"),

		lastError: text("last_error"),
		/** Coded form of the error (see `ErrorInfo` in #/libs/coded.ts). */
		lastErrorCode: text("last_error_code"),
		lastErrorParams: jsonb("last_error_params").$type<CodedParams>(),

		/**
		 * Cloudflare Tunnel (token-based, remotely managed): the connector
		 * token, encrypted. `tunnelEnabled` = a cloudflared container is
		 * converged on the server and "via tunnel" domains are allowed.
		 */
		tunnelTokenEncrypted: text("tunnel_token_encrypted"),
		tunnelEnabled: boolean("tunnel_enabled").default(false).notNull(),
		/**
		 * Tunnel only: Traefik publishes no host ports (80/443 may stay
		 * closed); every domain of the server is served through the tunnel.
		 */
		tunnelOnly: boolean("tunnel_only").default(false).notNull(),
		/**
		 * Resource policy (M6): every app service must run with a memory
		 * limit. Services without one get `defaultMemoryMb`; without that
		 * the deploy is refused, and removing a limit is refused too.
		 */
		requireLimits: boolean("require_limits").default(false).notNull(),
		defaultMemoryMb: integer("default_memory_mb"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		index("servers_team_id_idx").on(table.teamId),
		// One default (local) server per team.
		uniqueIndex("servers_team_default_idx")
			.on(table.teamId)
			.where(sql`${table.isDefault}`),
		index("servers_status_idx").on(table.status),
	],
);

// Deployments - track bootstrap and app deploys
// (in practice every background job: tests, bootstraps, deploys, backups,
// terminal sessions; `type` tells them apart)
export const deployments = pgTable(
	"deployments",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		serverId: uuid("server_id")
			.notNull()
			.references(() => servers.id, { onDelete: "cascade" }),
		/** Owning team (access is checked against the caller's team). */
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		/** Member who started the job (kept when the member leaves). */
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),

		/** Job kind, see `jobTypes` in #/config/status.ts. */
		type: text("type").notNull(),
		// Plain uuid (no FK) so job history survives app deletion.
		appId: uuid("app_id"),
		/** Source-language title for API v1 clients; the UI renders the coded one. */
		title: text("title").notNull(),
		/** Title key in `jobTitles` (#/config/job-titles.ts); null = `type`. */
		titleKey: text("title_key"),
		titleParams: jsonb("title_params").$type<CodedParams>().notNull(),

		status: deploymentStatusEnum("status").default("pending").notNull(),
		errorMessage: text("error_message"),
		/** Coded form of the error (see `ErrorInfo` in #/libs/coded.ts). */
		errorCode: text("error_code"),
		errorParams: jsonb("error_params").$type<CodedParams>(),

		/**
		 * App services this job stopped and has not started again. A job
		 * that ends (or a process that dies) with services listed here gets
		 * them restarted by the recovery path.
		 */
		stoppedServices: jsonb("stopped_services").$type<string[]>(),
		/** Staging folder on the server (removed by recovery if left behind). */
		workDir: text("work_dir"),
		/**
		 * What recovery must undo if the process dies mid-job (e.g. an app
		 * move: original domain hosts, target server, whether the copy
		 * landed). Never holds secrets.
		 */
		rollback: jsonb("rollback").$type<Record<string, unknown>>(),
		/**
		 * Problems the job tolerated (e.g. SQL errors of a database restore):
		 * it succeeded with warnings, shown as a badge.
		 */
		warningCount: integer("warning_count").default(0).notNull(),
		/**
		 * Commit the job deployed (template deploys and git builds), set once
		 * the job resolves it; the git release of that commit holds its
		 * message and author.
		 */
		commitSha: text("commit_sha"),
		/** A user asked to cancel the job. */
		cancelRequestedAt: timestamp("cancel_requested_at"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		index("deployments_server_id_idx").on(table.serverId),
		index("deployments_team_id_idx").on(table.teamId, table.createdAt),
		index("deployments_status_idx").on(table.status),
		index("deployments_app_id_idx").on(table.appId),
	],
);

// Deployment logs - one row per line, written incrementally while a job runs
export const deploymentLogs = pgTable(
	"deployment_logs",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		deploymentId: uuid("deployment_id")
			.notNull()
			.references(() => deployments.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		/** `[HH:MM:SS] text`: raw output, or an event in the source language. */
		line: text("line").notNull(),
		/** Log event code (#/config/job-log-events.ts); null for raw output. */
		code: text("code"),
		params: jsonb("params").$type<CodedParams>(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("deployment_logs_deployment_seq_idx").on(
			table.deploymentId,
			table.seq,
		),
	],
);
