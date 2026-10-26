import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	BuildSettings,
	DeliveryStatus,
	GitAuthKind,
	ReleaseStatus,
	RuntimeSettings,
} from "#/features/git/schema.ts";
import { apps } from "./apps";
import { deployments } from "./server";
import { teams } from "./teams";
import { users } from "./user";

/**
 * Git apps (R2 M1). A credential (deploy key or HTTPS token) is created in
 * the wizard before its app exists (`app_id` null, removed after
 * GIT_PENDING_KEY_TTL_HOURS when never attached) and belongs to one app.
 */
export const gitCredentials = pgTable(
	"git_credentials",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		appId: uuid("app_id").references(() => apps.id, { onDelete: "cascade" }),
		kind: text("kind").$type<Exclude<GitAuthKind, "none">>().notNull(),
		/** Deploy key: OpenSSH public key shown to the owner. */
		publicKey: text("public_key"),
		fingerprint: text("fingerprint"),
		/** Token: HTTPS user name. */
		username: text("username"),
		/** Private key (OpenSSH) or token, encrypted. Never sent to clients. */
		secretEncrypted: text("secret_encrypted").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("git_credentials_team_idx").on(table.teamId),
		uniqueIndex("git_credentials_app_idx")
			.on(table.appId)
			.where(sql`${table.appId} is not null`),
	],
);

/** Where a git app's code comes from and how it is built and run (1:1). */
export const appGitSources = pgTable(
	"app_git_sources",
	{
		appId: uuid("app_id")
			.primaryKey()
			.references(() => apps.id, { onDelete: "cascade" }),
		repoUrl: text("repo_url").notNull(),
		branch: text("branch").notNull(),
		subdir: text("subdir").default("").notNull(),
		submodules: boolean("submodules").default(false).notNull(),
		auth: text("auth").$type<GitAuthKind>().default("none").notNull(),
		credentialId: uuid("credential_id").references(() => gitCredentials.id, {
			onDelete: "set null",
		}),
		allowPrivateHost: boolean("allow_private_host").default(false).notNull(),
		build: jsonb("build").$type<BuildSettings>().notNull(),
		runtime: jsonb("runtime").$type<RuntimeSettings>().notNull(),
		/** Encrypted JSON `{ NAME: value }` of BuildKit secrets. */
		buildSecretsEncrypted: text("build_secrets_encrypted"),
		/** Builder found by the last auto-detection (shown in Settings). */
		detectedBuilder: text("detected_builder"),
		/** Images kept for rollback (null = GIT_KEEP_IMAGES). */
		keepImages: integer("keep_images"),
		/** Random id in the webhook URL (not the app id: reveals nothing). */
		webhookId: text("webhook_id").notNull(),
		webhookSecretEncrypted: text("webhook_secret_encrypted").notNull(),
		webhookEnabled: boolean("webhook_enabled").default(true).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [uniqueIndex("app_git_sources_webhook_idx").on(table.webhookId)],
);

/**
 * One built commit of a git app: its image `<folder>:<sha>` on the app's
 * server. Ready releases whose image is kept are rollback targets.
 */
export const appReleases = pgTable(
	"app_releases",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		appId: uuid("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		commitSha: text("commit_sha").notNull(),
		message: text("message").default("").notNull(),
		author: text("author").default("").notNull(),
		committedAt: timestamp("committed_at"),
		imageTag: text("image_tag").notNull(),
		builder: text("builder"),
		status: text("status").$type<ReleaseStatus>().notNull(),
		buildDeploymentId: uuid("build_deployment_id").references(
			() => deployments.id,
			{ onDelete: "set null" },
		),
		buildDurationMs: integer("build_duration_ms"),
		lastDeployedAt: timestamp("last_deployed_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("app_releases_app_sha_idx").on(table.appId, table.commitSha),
		index("app_releases_app_created_idx").on(table.appId, table.createdAt),
		index("app_releases_build_deployment_idx").on(table.buildDeploymentId),
	],
);

/** Push webhook deliveries (kept: WEBHOOK_DELIVERIES_KEPT per app). */
export const gitWebhookDeliveries = pgTable(
	"git_webhook_deliveries",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		appId: uuid("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		provider: text("provider").notNull(),
		/** Provider delivery id (replay protection), when it sends one. */
		deliveryId: text("delivery_id"),
		event: text("event"),
		branch: text("branch"),
		commitSha: text("commit_sha"),
		status: text("status").$type<DeliveryStatus>().notNull(),
		reason: text("reason"),
		deploymentId: uuid("deployment_id").references(() => deployments.id, {
			onDelete: "set null",
		}),
		ip: text("ip"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("git_webhook_deliveries_app_idx").on(table.appId, table.createdAt),
		index("git_webhook_deliveries_deployment_idx").on(table.deploymentId),
		uniqueIndex("git_webhook_deliveries_delivery_idx")
			.on(table.appId, table.provider, table.deliveryId)
			.where(sql`${table.deliveryId} is not null`),
	],
);
