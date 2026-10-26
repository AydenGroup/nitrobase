import {
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
import type { CheckDetail } from "#/config/check-details.ts";
import type { CodedParams } from "#/libs/coded.ts";
import { servers } from "./server";
import { teams } from "./teams";
import { users } from "./user";

export const appStatusEnum = pgEnum("app_status", [
	"pending",
	"deploying",
	"running",
	"stopped",
	"error",
	"deleting",
]);

/** Status of one domain check (stored in `domains.checks`, not a column). */
export const DOMAIN_CHECK_STATUSES = [
	"unknown",
	"ok",
	"warning",
	"error",
] as const;

export type DomainCheckStatusValue = (typeof DOMAIN_CHECK_STATUSES)[number];

/** Result of one registered domain checker, keyed by checker id. */
export interface DomainCheckResultRecord {
	status: DomainCheckStatusValue;
	/** Code + params, rendered in the viewer's locale. */
	message: CheckDetail;
	checkedAt: string;
}

export interface AppInputs {
	/** User-provided variable values (deploy form + env editor). */
	overrides: Record<string, string>;
	/** Variables defined by the template (incl. upstream defaults) at the last render. */
	templateKeys?: string[];
	/**
	 * Set when a deploy first reaches `compose up` (the app may have
	 * initialised its data, even if the deploy failed later): the template
	 * `initial_only` variables that were in the env then, which the app has
	 * read and ignores from now on. Kept for the app's lifetime (a move or a
	 * restore keeps the data); unset: never started.
	 */
	initialised?: string[];
	/** Owner-enabled published ports: template port id -> host port. */
	publishedPorts?: Record<string, number>;
	/** Published port ids bound on 127.0.0.1 only (SSH tunnel access). */
	loopbackPorts?: string[];
	/**
	 * Rotated variables whose template `on_rotate` step failed or could not
	 * run (the overview offers to run it again); cleared when it succeeds.
	 */
	rotateHookFailed?: string[];
	/**
	 * Services the owner stopped one by one (`nextStoppedServices`): left
	 * out of the stopped-service alert and the "partially running" status
	 * until started again or the app is started, restarted or deployed.
	 */
	stoppedServices?: string[];
	/**
	 * Resource limit overrides per service (M6). A field set to `null`
	 * removes the template default; a missing field keeps it.
	 */
	resources?: Record<
		string,
		{
			memoryMb?: number | null;
			memoryReservationMb?: number | null;
			cpus?: number | null;
		}
	>;
}

// Apps deployed from templates. One folder per app on its server.
export const apps = pgTable(
	"apps",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		/** Owning team (access is checked against the caller's team). */
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		/** Member who created it (kept when the member leaves). */
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		serverId: uuid("server_id")
			.notNull()
			.references(() => servers.id, { onDelete: "restrict" }),
		name: text("name").notNull(),
		templateId: text("template_id").notNull(),
		/** Version label the user picked (tag/release/commit). */
		version: text("version").notNull(),
		/** Commit SHA the version was resolved to at the last deploy. */
		commitSha: text("commit_sha"),
		/** `<templateId>-<appId 8 chars>`: host folder + compose project. */
		folder: text("folder").notNull(),
		status: appStatusEnum("status").default("pending").notNull(),
		/** Encrypted JSON of the last rendered env values (contains secrets). */
		envEncrypted: text("env_encrypted"),
		/**
		 * Set while `envEncrypted` holds values a deploy wrote to the server
		 * but that never went live (stored before the upload; the deploy
		 * failed or was interrupted). Cleared by a successful deploy.
		 */
		envPendingAt: timestamp("env_pending_at"),
		/**
		 * While pending: encrypted JSON of the env that was live before (null:
		 * never deployed). Diffs (update previews) compare against it.
		 */
		envDeployedEncrypted: text("env_deployed_encrypted"),
		/**
		 * Encrypted JSON `{ service: { NAME: value } }` for the template's
		 * `service_env` files (e.g. edge function secrets). Never sent to clients.
		 */
		serviceEnvEncrypted: text("service_env_encrypted"),
		/**
		 * Custom compose apps (inline template): encrypted JSON of the owner's
		 * compose, env, routed service/port and backup volumes.
		 */
		customSpecEncrypted: text("custom_spec_encrypted"),
		inputs: jsonb("inputs")
			.$type<AppInputs>()
			.default({ overrides: {} })
			.notNull(),
		/** Last deployed (transformed) compose file; no secrets. */
		composeDeployed: text("compose_deployed"),
		needsRedeploy: boolean("needs_redeploy").default(false).notNull(),
		/** Domain changes not yet written to Traefik (routes job couldn't start). */
		routesPending: boolean("routes_pending").default(false).notNull(),
		lastError: text("last_error"),
		/** Coded form of the error (see `ErrorInfo` in #/libs/coded.ts). */
		lastErrorCode: text("last_error_code"),
		lastErrorParams: jsonb("last_error_params").$type<CodedParams>(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		index("apps_team_id_idx").on(table.teamId),
		// Also serves lookups by server alone (leading column).
		uniqueIndex("apps_server_folder_idx").on(table.serverId, table.folder),
	],
);

// Hostnames routed by Traefik to an app service. `host` is globally unique.
export const domains = pgTable(
	"domains",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		appId: uuid("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		host: text("host").notNull(),
		service: text("service").notNull(),
		port: integer("port").notNull(),
		https: boolean("https").default(true).notNull(),
		primary: boolean("primary").default(false).notNull(),
		/** Which provider created it (e.g. "sslip.io"), null for user domains. */
		provider: text("provider"),
		/**
		 * Served through the server's Cloudflare Tunnel: Traefik routes it on
		 * the plain HTTP entrypoint (Cloudflare terminates TLS) and the DNS
		 * A-record check is replaced by the tunnel status.
		 */
		viaTunnel: boolean("via_tunnel").default(false).notNull(),
		/** Checker id -> latest result (see domain checker registry). */
		checks: jsonb("checks")
			.$type<Record<string, DomainCheckResultRecord>>()
			.default({})
			.notNull(),
		lastCheckedAt: timestamp("last_checked_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("domains_host_idx").on(table.host),
		index("domains_app_id_idx").on(table.appId),
	],
);
