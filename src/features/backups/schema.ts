import type { I18n } from "@lingui/core";
import { z } from "zod";
import { BACKUP_KINDS, BACKUP_STATUSES } from "#/config/enums.ts";
import { BACKUP_POLICY, MAX_DAYS, NAME_MAX_LENGTH } from "#/config/shared.ts";
import type {
	backupDestinations,
	backupPolicies,
	backups,
	DestinationTestRecord,
} from "#/db/schema/backups";
import type { ErrorInfo } from "#/libs/coded.ts";

export type DestinationRow = typeof backupDestinations.$inferSelect;
export type PolicyRow = typeof backupPolicies.$inferSelect;
export type BackupRow = typeof backups.$inferSelect;

export const DestinationInputSchema = (i18n: I18n) =>
	z.object({
		name: z
			.string()
			.trim()
			.min(1, { message: i18n._("Name is required") })
			.max(NAME_MAX_LENGTH),
		type: z.string().regex(/^[a-z0-9-]+$/),
		/** Driver config; validated by the driver schema on the server. */
		config: z.record(z.string(), z.unknown()),
	});

export const UpdateDestinationSchema = (i18n: I18n) =>
	DestinationInputSchema(i18n).extend({ id: z.guid() });

export const DestinationIdSchema = z.object({ id: z.guid() });

export const TestDestinationSchema = z.object({
	id: z.guid(),
	/** Server whose rclone runs the probe (default: the first ready one). */
	serverId: z.guid().optional(),
});

export const PolicyInputSchema = z.object({
	appId: z.guid(),
	destinationId: z.guid(),
	cron: z.string().trim().min(9).max(100),
	keepLast: z.number().int().min(1).max(BACKUP_POLICY.maxKeepLast).nullable(),
	keepDays: z.number().int().min(1).max(MAX_DAYS).nullable(),
	/** Retention also prunes manual backups (same app and destination). */
	includeManual: z.boolean().default(false),
	enabled: z.boolean(),
});

export const PanelPolicyInputSchema = PolicyInputSchema.omit({
	appId: true,
}).extend({ serverId: z.guid() });

export const RunBackupSchema = z.object({
	appId: z.guid(),
	/** Default: the app's policy destination. */
	destinationId: z.guid().optional(),
});

export const RunPanelBackupSchema = z.object({
	destinationId: z.guid(),
	serverId: z.guid(),
});

export const BackupIdSchema = z.object({ id: z.guid() });

/** Manual cleanup: also remove these staging folders (absolute paths). */
export const SweepWorkDirsSchema = z.object({
	serverId: z.guid(),
	paths: z
		.array(z.string().regex(/^\/[\w./-]+$/))
		.max(500)
		.default([]),
});

export const BackupListSchema = z.object({
	appId: z.guid().optional(),
	destinationId: z.guid().optional(),
	status: z.enum(BACKUP_STATUSES).optional(),
	kind: z.enum(BACKUP_KINDS).optional(),
});

export const RestoreSchema = z.discriminatedUnion("mode", [
	z.object({
		id: z.guid(),
		mode: z.literal("overwrite"),
		/** The app's folder, typed to confirm. */
		confirmName: z.string(),
	}),
	z.object({
		id: z.guid(),
		mode: z.literal("clone"),
		serverId: z.guid(),
		name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
		/** Empty: a free domain is generated. */
		domain: z.string().trim().max(253).optional(),
	}),
]);
export type RestoreInput = z.infer<typeof RestoreSchema>;

/** Variables a clone changes vs keeps (template-level, no secret values). */
export interface RestoreClonePreview {
	/** Recomputed for the new domain. */
	recomputed: { name: string; label: string }[];
	/** Editable credentials kept from the original app. */
	kept: { name: string; label: string }[];
	/**
	 * Credentials only read on the app's first start (`initial_only`): the
	 * restored data holds the current ones (they may differ from the env).
	 */
	fromData: { name: string; label: string }[];
	/**
	 * Why a new app cannot be made from this backup (its version is below
	 * the template's `min_version`), or null. Restoring over the existing
	 * app still works.
	 */
	blocked: ErrorInfo | null;
}

// DTOs (no secrets)

export interface DestinationDTO {
	id: string;
	name: string;
	type: string;
	/** Config with secret fields masked. */
	config: Record<string, string | number | boolean | null>;
	createdAt: Date;
	updatedAt: Date;
	backups: number;
	lastTest: DestinationTestRecord | null;
}

export interface PolicyDTO {
	id: string;
	appId: string | null;
	serverId: string | null;
	destinationId: string;
	cron: string;
	keepLast: number | null;
	keepDays: number | null;
	includeManual: boolean;
	enabled: boolean;
	lastRunAt: Date | null;
	nextRunAt: Date | null;
}

export type BackupDTO = Omit<
	BackupRow,
	"userId" | "teamId" | "customSpecEncrypted"
> & {
	destinationName: string | null;
};

export type DestinationTestResult = DestinationTestRecord;

/** Backups of one app, as the app page and risky-action dialogs show them. */
export interface AppBackupSummary {
	destinations: { id: string; name: string; onServer: boolean }[];
	/** Used by "Back up first" and preselected in "Back up now". */
	defaultDestinationId: string | null;
	lastBackup: {
		at: Date;
		status: "running" | "success" | "failed" | "corrupt";
		destinationName: string | null;
		sizeBytes: number | null;
	} | null;
	schedule: { enabled: boolean; cron: string } | null;
	/** The template stops services during a backup (consistent copy). */
	stopsApp: boolean;
	/** Median duration of recent successful backups (an upper bound of the stop). */
	estimatedSeconds: number | null;
}
