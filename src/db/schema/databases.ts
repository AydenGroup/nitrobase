import {
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type { LinkEnvEntry } from "#/server/services/databases/links.ts";
import { apps } from "./apps";
import { teams } from "./teams";
import { users } from "./user";

/**
 * Database links (R3 M2): an app on the same server as a database gets its
 * connection env and joins a private network shared only with the
 * database service (see #/server/services/databases/links.ts). A database
 * is an app of source kind `database` (engine and image tag in its
 * version); this table is the only database-specific state.
 */
export const databaseLinks = pgTable(
	"database_links",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		/** The database (an app of kind `database`). */
		databaseAppId: uuid("database_app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		/** The app that uses it. */
		appId: uuid("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		/** Env vars the app gets (URL and/or parts). */
		env: jsonb("env").$type<LinkEnvEntry[]>().notNull(),
		/** Database the URL points at (null: the database's own). */
		database: text("database"),
		/** Login the URL uses (null: the database's main user). */
		username: text("username"),
		/** Password of `username`, encrypted (null with the main user). */
		passwordEncrypted: text("password_encrypted"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("database_links_team_idx").on(table.teamId),
		index("database_links_app_idx").on(table.appId),
		uniqueIndex("database_links_pair_idx").on(table.databaseAppId, table.appId),
	],
);
