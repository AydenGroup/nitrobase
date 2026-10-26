import type { I18n } from "@lingui/core";
import { z } from "zod";
import { MAX_SYNC_PARTS, SYNC_PART_PATTERN } from "#/config/cloud-sync.ts";
import { NAME_MAX_LENGTH } from "#/config/shared.ts";
import type {
	CloudConnectionTestRecord,
	CloudSyncSummary,
	cloudConnections,
	cloudSyncs,
} from "#/db/schema/cloud-sync.ts";

export type { CloudPreflight } from "#/server/services/cloud-sync/types.ts";

export type CloudConnectionRow = typeof cloudConnections.$inferSelect;
export type CloudSyncRow = typeof cloudSyncs.$inferSelect;

export const CloudConnectionInputSchema = (i18n: I18n) =>
	z.object({
		name: z
			.string()
			.trim()
			.min(1, { message: i18n._("Name is required") })
			.max(NAME_MAX_LENGTH),
		provider: z.string().regex(/^[a-z0-9-]+$/),
		/** Provider config; validated by the provider schema on the server. */
		config: z.record(z.string(), z.unknown()),
	});

export const UpdateCloudConnectionSchema = (i18n: I18n) =>
	CloudConnectionInputSchema(i18n).extend({ id: z.guid() });

export const CloudConnectionIdSchema = z.object({ id: z.guid() });

/** Part ids (checked against the provider's parts on the server). */
const parts = z
	.array(z.string().regex(SYNC_PART_PATTERN).max(64))
	.min(1)
	.max(MAX_SYNC_PARTS);

/** A template release (empty: the latest stable one). */
const release = z
	.string()
	.trim()
	.max(200)
	.regex(/^[\w][\w./@-]*$/)
	.optional();

/** Per-run inputs (`provider.importSchema`/`exportSchema`, checked on the server). */
const syncInputs = z.record(z.string().max(64), z.unknown()).default({});
const exportInputs = syncInputs;

export const CloudPreflightSchema = z.object({
	connectionId: z.guid(),
	serverId: z.guid(),
	parts,
	version: release,
	inputs: syncInputs,
});

export const CloudImportSchema = CloudPreflightSchema.extend({
	name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
	/** Empty: a free domain is generated. */
	domain: z.string().trim().max(253).optional(),
});
export type CloudImportInput = z.infer<typeof CloudImportSchema>;

export const AppSyncsSchema = z.object({ appId: z.guid() });

export const CloudExportOptionsSchema = z.object({
	appId: z.guid(),
	connectionId: z.guid(),
	inputs: exportInputs,
});
export type CloudExportOptionsInput = z.infer<typeof CloudExportOptionsSchema>;

export const CloudExportPreflightSchema = z.object({
	appId: z.guid(),
	connectionId: z.guid(),
	parts,
	inputs: exportInputs,
});
export type CloudExportPreflightInput = z.infer<
	typeof CloudExportPreflightSchema
>;

export const CloudExportSchema = CloudExportPreflightSchema.extend({
	/** The cloud project's ID, typed by the member to confirm. */
	confirm: z.string().trim().min(1).max(128),
});
export type CloudExportInput = z.infer<typeof CloudExportSchema>;

// DTOs (no secrets)

export interface CloudConnectionDTO {
	id: string;
	name: string;
	provider: string;
	/** Config with secret fields masked. */
	config: Record<string, string | number | boolean | null>;
	createdAt: Date;
	updatedAt: Date;
	lastTest: CloudConnectionTestRecord | null;
}

export interface CloudSyncDTO {
	id: string;
	provider: string;
	direction: string;
	project: string;
	connectionId: string | null;
	connectionName: string;
	parts: string[];
	status: string;
	deploymentId: string | null;
	summary: CloudSyncSummary | null;
	createdAt: Date;
	finishedAt: Date | null;
}
