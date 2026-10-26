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
	uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams";
import { users } from "./user";

/** Audit trail (actions: #/config/audit-actions.ts). Never holds secrets. */
export const auditEvents = pgTable(
	"audit_events",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		// Plain uuids: the trail outlives deleted users and teams.
		userId: uuid("user_id"),
		/** Team the action happened in; null for account events (sign-in, 2FA). */
		teamId: uuid("team_id"),
		action: text("action").notNull(),
		targetType: text("target_type"),
		targetId: text("target_id"),
		ip: text("ip"),
		userAgent: text("user_agent"),
		meta: jsonb("meta").$type<Record<string, unknown>>(),
		at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// Keyset pages: newest id first per user.
		index("audit_events_user_id_idx").on(table.userId, table.id),
		index("audit_events_team_id_idx").on(table.teamId, table.id),
		index("audit_events_at_idx").on(table.at),
		index("audit_events_action_idx").on(table.action, table.at),
	],
);

export interface ChannelTestRecord {
	ok: boolean;
	error: string | null;
	at: string;
}

/** Which events reach a channel, optionally only for some servers/apps. */
export interface ChannelSubscription {
	events: string[];
	serverIds: string[];
	appIds: string[];
}

/** Notification channels (drivers: #/config/notification-channels.ts). */
export const notificationChannels = pgTable(
	"notification_channels",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		/** Owning team (access is checked against the caller's team). */
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		/** Member who added it; account security events reach its creator's channels (kept when the member leaves). */
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		type: text("type").notNull(),
		/** Encrypted JSON of the driver config (secrets included). */
		configEncrypted: text("config_encrypted").notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		subscription: jsonb("subscription").$type<ChannelSubscription>().notNull(),
		lastTest: jsonb("last_test").$type<ChannelTestRecord>(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [index("notification_channels_team_idx").on(table.teamId)],
);

export const deliveryStatusEnum = pgEnum("notification_delivery_status", [
	"pending",
	"sent",
	"failed",
	/** Dropped by dedupe or the per-channel rate limit. */
	"suppressed",
]);

export const notificationDeliveries = pgTable(
	"notification_deliveries",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		channelId: uuid("channel_id")
			.notNull()
			.references(() => notificationChannels.id, { onDelete: "cascade" }),
		eventId: text("event_id").notNull(),
		/** Event + subject: the dedupe key. */
		dedupeKey: text("dedupe_key").notNull(),
		title: text("title").notNull(),
		status: deliveryStatusEnum("status").default("pending").notNull(),
		attempts: integer("attempts").default(0).notNull(),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		sentAt: timestamp("sent_at", { withTimezone: true }),
	},
	(table) => [
		index("notification_deliveries_channel_idx").on(
			table.channelId,
			table.createdAt,
		),
		index("notification_deliveries_dedupe_idx").on(
			table.channelId,
			table.dedupeKey,
			table.createdAt,
		),
		index("notification_deliveries_created_idx").on(table.createdAt),
	],
);
