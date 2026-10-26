import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams";

/**
 * Panel accounts. The first account bootstraps the instance (instance
 * admin); later accounts only sign up through a team invite. `email` is stored normalized
 * (`normalizeEmail`: trimmed, lowercase) and unique case-insensitively.
 */
export const users = pgTable(
	"users",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		firstName: text("first_name").notNull(),
		lastName: text("last_name").notNull(),
		email: text("email").notNull(),
		// bcrypt hash (cost BCRYPT_COST)
		passwordHash: text("password_hash").notNull(),
		avatarUrl: text("avatar_url"),
		/**
		 * Instance administrator (the bootstrap account): instance settings
		 * and the Nitrobase self-backup, which span every team.
		 */
		instanceAdmin: boolean("instance_admin").default(false).notNull(),
		/** Encrypted base32 TOTP secret (2FA on when `totpEnabledAt` is set). */
		totpSecretEncrypted: text("totp_secret_encrypted"),
		/** Secret being enrolled, until the first code confirms it. */
		totpPendingSecretEncrypted: text("totp_pending_secret_encrypted"),
		totpEnabledAt: timestamp("totp_enabled_at"),
		/** Last accepted TOTP time step (a code is never accepted twice). */
		totpLastStep: bigint("totp_last_step", { mode: "number" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("users_email_lower_idx").on(sql`lower(${table.email})`),
	],
);

/** One-time 2FA recovery codes (sha256 of the normalized code). */
export const userRecoveryCodes = pgTable(
	"user_recovery_codes",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		codeHash: text("code_hash").notNull(),
		usedAt: timestamp("used_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [index("user_recovery_codes_user_idx").on(table.userId)],
);

/**
 * Server-side sessions: the sealed cookie carries the id; a row that is
 * revoked or expired logs the cookie out.
 */
export const sessions = pgTable(
	"sessions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		ip: text("ip"),
		userAgent: text("user_agent"),
		revokedAt: timestamp("revoked_at"),
		/** Team the browser works in (team switcher). */
		activeTeamId: uuid("active_team_id").references(() => teams.id, {
			onDelete: "set null",
		}),
	},
	(table) => [index("sessions_user_idx").on(table.userId, table.createdAt)],
);

/**
 * Persisted sign-in / 2FA attempt counters (fixed windows), so a restart
 * does not clear a lockout. Keys are sha256 digests (no emails or IPs in
 * clear); the in-process limiter stays the front cache.
 */
export const rateLimits = pgTable(
	"rate_limits",
	{
		scope: text("scope").notNull(),
		keyHash: text("key_hash").notNull(),
		count: integer("count").notNull(),
		windowStart: timestamp("window_start").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.scope, table.keyHash] }),
		index("rate_limits_window_idx").on(table.windowStart),
	],
);
