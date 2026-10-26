import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { users } from "./user";

/**
 * Workspaces. Every resource (servers, keys, apps, backups, channels...)
 * belongs to exactly one team; members act on it with the permissions of
 * their role (#/config/permissions.ts). `personal` marks the team created
 * for an account (first sign-up).
 */
export const teams = pgTable("teams", {
	id: uuid("id").defaultRandom().primaryKey(),
	/** User text; null = never named (shown as `defaultTeamName`). */
	name: text("name"),
	personal: boolean("personal").default(false).notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Membership: one role (registry id) per user and team. */
export const teamMembers = pgTable(
	"team_members",
	{
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.teamId, table.userId] }),
		index("team_members_user_idx").on(table.userId),
	],
);

/**
 * Pending invitations. Only the sha256 of the token is stored; the link is
 * shown once to the inviter (and mailed when the team has an email channel).
 */
export const teamInvites = pgTable(
	"team_invites",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		/** Normalized email the invite is for; null = anyone with the link. */
		email: text("email"),
		role: text("role").notNull(),
		tokenHash: text("token_hash").notNull(),
		createdBy: uuid("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		expiresAt: timestamp("expires_at").notNull(),
		acceptedAt: timestamp("accepted_at"),
		acceptedBy: uuid("accepted_by").references(() => users.id, {
			onDelete: "set null",
		}),
		revokedAt: timestamp("revoked_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("team_invites_token_hash_idx").on(table.tokenHash),
		index("team_invites_team_idx").on(table.teamId, table.createdAt),
	],
);

/**
 * API tokens for `/api/v1`. `userId` set = personal token (acts as that
 * member, never beyond the member's current role); null = team token.
 * Stored as sha256 of the full secret; `prefix` identifies it in lists.
 */
export const apiTokens = pgTable(
	"api_tokens",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "cascade",
		}),
		createdBy: uuid("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		prefix: text("prefix").notNull(),
		tokenHash: text("token_hash").notNull(),
		permissions: jsonb("permissions").$type<string[]>().notNull(),
		expiresAt: timestamp("expires_at"),
		lastUsedAt: timestamp("last_used_at"),
		lastUsedIp: text("last_used_ip"),
		revokedAt: timestamp("revoked_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("api_tokens_prefix_idx").on(table.prefix),
		index("api_tokens_team_idx").on(table.teamId),
		index("api_tokens_user_idx")
			.on(table.userId)
			.where(sql`${table.userId} is not null`),
	],
);
