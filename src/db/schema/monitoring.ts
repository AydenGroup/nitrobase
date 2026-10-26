import { sql } from "drizzle-orm";
import {
	bigint,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	real,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { servers } from "./server";
import { teams } from "./teams";

/** One filesystem in a server sample (bytes). */
export interface DiskUsageRecord {
	mount: string;
	fs: string;
	used: number;
	total: number;
	/** Bytes available to unprivileged users (df "Available"). */
	avail: number;
}

/**
 * Server samples. `bucket_seconds` = 0 for raw samples (kept
 * METRICS_RAW_RETENTION_HOURS), else the rollup bucket width (averages).
 */
export const metricsServer = pgTable(
	"metrics_server",
	{
		serverId: uuid("server_id")
			.notNull()
			.references(() => servers.id, { onDelete: "cascade" }),
		ts: timestamp("ts", { withTimezone: true }).notNull(),
		bucketSeconds: integer("bucket_seconds").default(0).notNull(),
		cpuPercent: real("cpu_percent"),
		load1: real("load1"),
		load5: real("load5"),
		load15: real("load15"),
		memUsed: bigint("mem_used", { mode: "number" }),
		memTotal: bigint("mem_total", { mode: "number" }),
		swapUsed: bigint("swap_used", { mode: "number" }),
		swapTotal: bigint("swap_total", { mode: "number" }),
		netRxBps: real("net_rx_bps"),
		netTxBps: real("net_tx_bps"),
		uptimeSeconds: bigint("uptime_seconds", { mode: "number" }),
		disks: jsonb("disks").$type<DiskUsageRecord[]>().default([]).notNull(),
	},
	(table) => [
		// History queries and rollup upserts (one row per server/bucket/ts).
		uniqueIndex("metrics_server_server_bucket_ts_idx").on(
			table.serverId,
			table.bucketSeconds,
			table.ts,
		),
		// Retention deletes by resolution and age.
		index("metrics_server_bucket_ts_idx").on(table.bucketSeconds, table.ts),
	],
);

/** Container samples (all containers of the server; app via `nitrobase.app`). */
export const metricsContainer = pgTable(
	"metrics_container",
	{
		serverId: uuid("server_id")
			.notNull()
			.references(() => servers.id, { onDelete: "cascade" }),
		/** Only set when the label names an app on this server. */
		appId: uuid("app_id").references(() => apps.id, { onDelete: "cascade" }),
		container: text("container").notNull(),
		service: text("service"),
		ts: timestamp("ts", { withTimezone: true }).notNull(),
		bucketSeconds: integer("bucket_seconds").default(0).notNull(),
		state: text("state"),
		health: text("health"),
		restartCount: integer("restart_count"),
		cpuPercent: real("cpu_percent"),
		memUsed: bigint("mem_used", { mode: "number" }),
		memLimit: bigint("mem_limit", { mode: "number" }),
		netRxBps: real("net_rx_bps"),
		netTxBps: real("net_tx_bps"),
	},
	(table) => [
		uniqueIndex("metrics_container_server_name_bucket_ts_idx").on(
			table.serverId,
			table.container,
			table.bucketSeconds,
			table.ts,
		),
		index("metrics_container_app_bucket_ts_idx").on(
			table.appId,
			table.bucketSeconds,
			table.ts,
		),
		index("metrics_container_bucket_ts_idx").on(table.bucketSeconds, table.ts),
	],
);

export const alertStatusEnum = pgEnum("alert_status", ["open", "resolved"]);

/**
 * Alerts raised by the rule registry. At most one open alert per
 * (server, rule, subject); resolving keeps the row as history.
 */
export const alerts = pgTable(
	"alerts",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		/** The server's team (its notification channels receive it). */
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		serverId: uuid("server_id")
			.notNull()
			.references(() => servers.id, { onDelete: "cascade" }),
		appId: uuid("app_id").references(() => apps.id, { onDelete: "cascade" }),
		/** Rule id in the alert rule registry. */
		rule: text("rule").notNull(),
		/** What the rule is about: a mount, a container, or "server". */
		subject: text("subject").notNull(),
		severity: text("severity").notNull(),
		status: alertStatusEnum("status").default("open").notNull(),
		value: real("value"),
		threshold: real("threshold"),
		openedAt: timestamp("opened_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		/** Last tick that confirmed the condition. */
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("alerts_open_subject_idx")
			.on(table.serverId, table.rule, table.subject)
			.where(sql`${table.status} = 'open'`),
		index("alerts_team_status_idx").on(table.teamId, table.status),
		index("alerts_server_status_idx").on(table.serverId, table.status),
		index("alerts_app_status_idx").on(table.appId, table.status),
	],
);
