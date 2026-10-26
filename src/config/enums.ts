/**
 * Value lists of DB enums that client code validates too (URL search
 * params, filters). The Postgres enums are built from these lists, so
 * client schemas and the database can't drift. Macro-free: drizzle-kit
 * loads it. Append new values; never reorder or remove (a migration
 * changes the enum).
 */

/** `deployments.status`: a background job. */
export const DEPLOYMENT_STATUSES = [
	"pending",
	"running",
	"success",
	"failed",
] as const;

/** `backups.kind`. */
export const BACKUP_KINDS = ["full", "db", "files", "panel"] as const;

/** `backups.status` (`corrupt`: the archive failed verification). */
export const BACKUP_STATUSES = [
	"running",
	"success",
	"failed",
	"corrupt",
] as const;
