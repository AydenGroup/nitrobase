import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { z } from "zod";
import type { AuditActionId } from "./audit-actions";
import {
	field,
	type SchemaField,
	schemaFields,
	secretFieldNames,
	validation,
} from "./schema-fields";
import type { JobType } from "./status";

/**
 * Cloud sync providers (client-safe): one-off copies between a hosted
 * service and an app Nitrobase deploys from one of its templates. Adding a
 * provider = one entry here (connection form, parts, allowed hosts) plus a
 * server driver in `#/server/services/cloud-sync/drivers.ts`. Callers check
 * the registry, never a provider id.
 */

export type SyncDirection = "import" | "export";

/** A part id (what a sync copies), declared per provider below. */
export type SyncPart = string;

/** Part ids: lowercase snake_case (stored in `cloud_syncs.parts`). */
export const SYNC_PART_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Most parts a provider declares (bounds request validation). */
export const MAX_SYNC_PARTS = 16;

interface CloudSyncPart {
	id: SyncPart;
	label: MessageDescriptor;
	/** Directions this part supports today. */
	directions: readonly SyncDirection[];
}

export const syncDirectionLabels = {
	import: msg({ id: "Import" }),
	export: msg({ id: "Export" }),
} satisfies Record<SyncDirection, MessageDescriptor>;

/** A step of a connection test (stored in `lastTest.steps[].step`). */
export type ConnectionTestStep = string;

interface CloudConnectionTestStep {
	id: ConnectionTestStep;
	label: MessageDescriptor;
}

/**
 * What a preflight counts (`CloudPreflight.contents[].counts[].unit`), as
 * plural messages of `{count}`.
 */
export const preflightCountUnits = {
	tables: msg({ id: "{count, plural, one {# table} other {# tables}}" }),
	rows: msg({ id: "{count, plural, one {# row} other {# rows}}" }),
	objects: msg({ id: "{count, plural, one {# object} other {# objects}}" }),
	buckets: msg({ id: "{count, plural, one {# bucket} other {# buckets}}" }),
	files: msg({ id: "{count, plural, one {# file} other {# files}}" }),
	users: msg({ id: "{count, plural, one {# user} other {# users}}" }),
	teams: msg({ id: "{count, plural, one {# team} other {# teams}}" }),
	memberships: msg({
		id: "{count, plural, one {# membership} other {# memberships}}",
	}),
	databases: msg({
		id: "{count, plural, one {# database} other {# databases}}",
	}),
	functions: msg({
		id: "{count, plural, one {# function} other {# functions}}",
	}),
	deployments: msg({
		id: "{count, plural, one {# deployment} other {# deployments}}",
	}),
	platforms: msg({
		id: "{count, plural, one {# platform} other {# platforms}}",
	}),
} satisfies Record<string, MessageDescriptor>;
export type PreflightCountUnit = keyof typeof preflightCountUnits;

export interface CloudSyncProvider<S extends z.ZodObject = z.ZodObject> {
	id: string;
	label: MessageDescriptor;
	/** Action on the New app page. */
	importLabel: MessageDescriptor;
	description: MessageDescriptor;
	/** Template of the app an import creates (and an export reads). */
	templateId: string;
	/** Connection form (fields carry form metadata via `.meta()`). */
	schema: S;
	/** What a sync can copy, in the order a job copies it. */
	parts: readonly CloudSyncPart[];
	/** What the preflight's versions are versions of (e.g. "Postgres"). */
	versionLabel: MessageDescriptor;
	/**
	 * Hosts the panel and the import containers may reach for this provider
	 * (SSRF allowlist; `*.suffix` matches subdomains). The server adds
	 * `CLOUD_SYNC_EXTRA_ALLOWED_HOSTS` (test doubles).
	 */
	allowedHosts: readonly string[];
	/** Config field naming the cloud project (shown in lists). */
	projectField: string;
	/** Steps of a connection test, in order. */
	testSteps: readonly CloudConnectionTestStep[];
	/** Labels of what a connection test reports (`info` keys). */
	infoLabels: Record<string, MessageDescriptor>;
	/** Job kind of an import (`jobTypes`) and its audit action. */
	importJobType: JobType;
	importAuditAction: AuditActionId;
	/** Action in the app's Cloud sync tab (export into an empty project). */
	exportLabel: MessageDescriptor;
	/** Job kind of an export (`jobTypes`) and its audit action. */
	exportJobType: JobType;
	exportAuditAction: AuditActionId;
	/**
	 * What the export modal asks for this job only (never stored): form
	 * fields like the connection's, validated on the server.
	 */
	exportSchema: z.ZodObject;
	/** What the import modal asks for this job only, like `exportSchema`. */
	importSchema: z.ZodObject;
}

/** No control characters: values end up in config files. */
const line = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.refine(
		(value) => !/[\r\n\0]/.test(value),
		validation(msg({ id: "Single line only" })),
	);

const optionalLine = line.or(z.literal("")).default("");

const hostname = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
		validation(msg({ id: "A host name, e.g. db.example.com" })),
	)
	.or(z.literal(""))
	.default("");

const pem = z
	.string()
	.trim()
	.max(64 * 1024)
	.refine(
		(value) =>
			value === "" ||
			/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(
				value,
			),
		validation(msg({ id: "One or more PEM certificates" })),
	)
	.default("");

const supabaseSchema = z.object({
	projectRef: z
		.string()
		.trim()
		.regex(
			/^[a-z]{20}$/,
			validation(msg({ id: "The 20-letter project reference" })),
		)
		.meta(
			field({
				label: msg({ id: "Project reference" }),
				help: msg({
					id: "From the project URL: https://<reference>.supabase.co",
				}),
				placeholder: "abcdefghijklmnopqrst",
			}),
		),
	accessToken: line.meta(
		field({
			label: msg({ id: "Personal access token" }),
			help: msg({
				id: "Account → Access tokens. Reads the project, its pooler settings and edge functions through the Management API.",
			}),
			secret: true,
		}),
	),
	dbPassword: line.meta(
		field({
			label: msg({ id: "Database password" }),
			help: msg({ id: "Project Settings → Database." }),
			secret: true,
		}),
	),
	s3AccessKeyId: optionalLine.meta(
		field({
			label: msg({ id: "Storage S3 access key ID" }),
			help: msg({
				id: "Project Settings → Storage → S3 access keys. Needed to copy storage files.",
			}),
		}),
	),
	s3SecretAccessKey: optionalLine.meta(
		field({
			label: msg({ id: "Storage S3 secret access key" }),
			secret: true,
		}),
	),
	poolerHost: hostname.meta(
		field({
			label: msg({ id: "Pooler host (optional)" }),
			help: msg({
				id: "Leave empty to read it from the project's settings (session pooler).",
			}),
			placeholder: "aws-1-eu-central-1.pooler.supabase.com",
		}),
	),
	caCertificate: pem.meta(
		field({
			label: msg({ id: "Extra CA certificate (optional)" }),
			help: msg({
				id: "PEM certificate the database server must chain to, in addition to the Supabase root CA configured on this instance.",
			}),
			multiline: true,
		}),
	),
});

export type SupabaseConnectionConfig = z.infer<typeof supabaseSchema>;

/** An Appwrite API endpoint: https, ending in /v1 (no query or fragment). */
const appwriteEndpoint = z
	.string()
	.trim()
	.max(512)
	.refine(
		(value) => {
			try {
				const url = new URL(value);
				return (
					url.protocol === "https:" &&
					!url.username &&
					!url.password &&
					!url.search &&
					!url.hash &&
					/^\/v1\/?$/.test(url.pathname)
				);
			} catch {
				return false;
			}
		},
		validation(msg({ id: "An https URL ending in /v1" })),
	)
	.transform((value) => value.replace(/\/+$/, ""));

const appwriteSchema = z.object({
	endpoint: appwriteEndpoint.meta(
		field({
			label: msg({ id: "API endpoint" }),
			help: msg({
				id: "Project → Settings → API credentials, e.g. https://fra.cloud.appwrite.io/v1",
			}),
			placeholder: "https://fra.cloud.appwrite.io/v1",
		}),
	),
	projectId: z
		.string()
		.trim()
		.regex(
			/^[a-z0-9][a-z0-9._-]{0,35}$/i,
			validation(msg({ id: "The project ID (up to 36 characters)" })),
		)
		.meta(
			field({
				label: msg({ id: "Project ID" }),
				help: msg({
					id: "The new app gets a project with the same ID, so clients only change the endpoint.",
				}),
			}),
		),
	apiKey: line.meta(
		field({
			label: msg({ id: "API key" }),
			help: msg({
				id: "Project → Overview → API keys. Create a dedicated key with a short expiry and only read access to what you import (users, teams, databases, tables, columns, indexes, rows, buckets, files, functions and platforms); to export an app into the project, add migrations.read and migrations.write. Revoke it afterwards.",
			}),
			secret: true,
		}),
	),
});

export type AppwriteConnectionConfig = z.infer<typeof appwriteSchema>;

/**
 * What a sync does with pg_cron jobs: re-create them paused (the default:
 * their commands may still call the old address), as they were, or not.
 */
export const CRON_JOB_MODES = ["paused", "active", "skip"] as const;
export type CronJobMode = (typeof CRON_JOB_MODES)[number];

/** `default`: the instance's CLOUD_SYNC_CRON_JOBS (resolved on the server). */
const CRON_JOB_CHOICE_DEFAULT = "default";

/** The per-run cron choice of an import or export (Supabase). */
const cronJobsField = z
	.enum([CRON_JOB_CHOICE_DEFAULT, ...CRON_JOB_MODES])
	.default(CRON_JOB_CHOICE_DEFAULT)
	.meta(
		field({
			label: msg({ id: "Cron jobs" }),
			help: msg({
				id: "pg_cron jobs are re-created by name in the destination. Paused jobs do not run until you turn them on: check first that their commands no longer call the old address.",
			}),
			options: [
				{
					value: CRON_JOB_CHOICE_DEFAULT,
					label: msg({ id: "This instance's default (CLOUD_SYNC_CRON_JOBS)" }),
				},
				{ value: "paused", label: msg({ id: "Copy them paused" }) },
				{ value: "active", label: msg({ id: "Copy them as they are" }) },
				{ value: "skip", label: msg({ id: "Do not copy them" }) },
			],
		}),
	);

const supabaseImportSchema = z.object({ cronJobs: cronJobsField });

const supabaseExportSchema = z.object({
	cronJobs: cronJobsField,
	stopWriters: z
		.boolean()
		.default(false)
		.meta(
			field({
				label: msg({ id: "Stop the app's services that write while copying" }),
				help: msg({
					id: "The database is copied as one consistent snapshot, files after it: writes in between may be missed. Stopping the writers makes the copy exact, but the app is unavailable meanwhile.",
				}),
			}),
		),
});

const appwriteExportSchema = z.object({
	localProjectId: z
		.string()
		.trim()
		.regex(
			/^[a-z0-9][a-z0-9._-]{0,35}$/i,
			validation(msg({ id: "The project ID (up to 36 characters)" })),
		)
		.or(z.literal(""))
		.default("")
		.meta(
			field({
				label: msg({ id: "Project of this app" }),
				help: msg({
					id: "The project to export, as its ID in this app's console.",
				}),
			}),
		),
	localApiKey: optionalLine.meta(
		field({
			label: msg({ id: "API key of this app's project" }),
			help: msg({
				id: "Only needed when the panel cannot sign in to this app's console: a key of the project with read access to what you export. Used for this export only, never stored.",
			}),
			secret: true,
		}),
	),
});

const both = ["import", "export"] as const satisfies readonly SyncDirection[];

export const cloudSyncProviders: CloudSyncProvider[] = [
	{
		id: "supabase",
		label: msg({ id: "Supabase" }),
		importLabel: msg({ id: "Import from Supabase cloud" }),
		description: msg({
			id: "A hosted Supabase project: database, storage files and edge functions.",
		}),
		templateId: "supabase",
		schema: supabaseSchema,
		parts: [
			{
				id: "database",
				label: msg({ id: "Database" }),
				directions: both,
			},
			{
				id: "storage",
				label: msg({ id: "Storage files" }),
				directions: both,
			},
			{
				id: "functions",
				label: msg({ id: "Edge functions" }),
				directions: both,
			},
		],
		versionLabel: msg({ id: "Postgres" }),
		allowedHosts: [
			"api.supabase.com",
			"*.supabase.co",
			"*.pooler.supabase.com",
		],
		projectField: "projectRef",
		testSteps: [
			{ id: "api", label: msg({ id: "Management API" }) },
			{ id: "database", label: msg({ id: "Database (pooler)" }) },
			{ id: "storage", label: msg({ id: "Storage (S3)" }) },
		],
		infoLabels: {
			project: msg({ id: "Project" }),
			region: msg({ id: "Region" }),
			status: msg({ id: "Status" }),
			postgres: msg({ id: "Postgres version" }),
			pooler: msg({ id: "Pooler" }),
			server: msg({ id: "Database server" }),
			buckets: msg({ id: "Buckets" }),
		},
		importJobType: "supabase_import",
		importAuditAction: "supabase.sync.import",
		exportLabel: msg({ id: "Export to Supabase cloud" }),
		exportJobType: "supabase_export",
		exportAuditAction: "supabase.sync.export",
		exportSchema: supabaseExportSchema,
		importSchema: supabaseImportSchema,
	},
	{
		id: "appwrite",
		label: msg({ id: "Appwrite" }),
		importLabel: msg({ id: "Import from Appwrite Cloud" }),
		description: msg({
			id: "An Appwrite Cloud project: users and teams, databases, storage files, function settings and platforms.",
		}),
		templateId: "appwrite",
		schema: appwriteSchema,
		parts: [
			{
				id: "auth",
				label: msg({ id: "Users and teams" }),
				directions: both,
			},
			{
				id: "databases",
				label: msg({ id: "Databases" }),
				directions: both,
			},
			{
				id: "storage",
				label: msg({ id: "Storage files" }),
				directions: both,
			},
			{
				id: "function_settings",
				label: msg({ id: "Functions (settings and variables)" }),
				directions: both,
			},
			{
				id: "platforms",
				label: msg({ id: "Platforms" }),
				directions: both,
			},
		],
		versionLabel: msg({ id: "Appwrite" }),
		allowedHosts: ["cloud.appwrite.io", "*.cloud.appwrite.io"],
		projectField: "projectId",
		testSteps: [
			{ id: "version", label: msg({ id: "Appwrite version" }) },
			{ id: "key", label: msg({ id: "API key" }) },
			{ id: "scopes", label: msg({ id: "Read access for the import" }) },
		],
		infoLabels: {
			project: msg({ id: "Project" }),
			version: msg({ id: "Appwrite version" }),
			users: msg({ id: "Users" }),
			databases: msg({ id: "Databases" }),
			buckets: msg({ id: "Buckets" }),
			functions: msg({ id: "Functions" }),
			missing: msg({ id: "No read access to" }),
		},
		importJobType: "appwrite_import",
		importAuditAction: "appwrite.sync.import",
		exportLabel: msg({ id: "Export to Appwrite Cloud" }),
		exportJobType: "appwrite_export",
		exportAuditAction: "appwrite.sync.export",
		exportSchema: appwriteExportSchema,
		importSchema: z.object({}),
	},
];

export function getCloudSyncProvider(id: string): CloudSyncProvider | null {
	return cloudSyncProviders.find((provider) => provider.id === id) ?? null;
}

/** Providers whose apps come from `templateId`. */
export function providersForTemplate(templateId: string): CloudSyncProvider[] {
	return cloudSyncProviders.filter(
		(provider) => provider.templateId === templateId,
	);
}

/** Parts `provider` can copy in `direction`, in copy order. */
export function partsFor(
	provider: CloudSyncProvider,
	direction: SyncDirection,
): SyncPart[] {
	return provider.parts
		.filter((part) => part.directions.includes(direction))
		.map((part) => part.id);
}

/**
 * Labels of every provider's parts by id (job log params, history rows of
 * a provider that is gone). Providers sharing an id share its meaning; the
 * registry test checks they share the label too.
 */
export const syncPartLabels: Record<string, MessageDescriptor> =
	Object.fromEntries(
		cloudSyncProviders
			.flatMap((provider) => provider.parts)
			.map((part) => [part.id, part.label]),
	);

/** Label of a part as `provider` names it (falls back to the shared one). */
export function syncPartLabel(
	provider: CloudSyncProvider | null,
	part: string,
): MessageDescriptor | undefined {
	return (
		provider?.parts.find((item) => item.id === part)?.label ??
		(Object.hasOwn(syncPartLabels, part) ? syncPartLabels[part] : undefined)
	);
}

/** What each provider's versions are versions of, by provider id. */
export const cloudVersionLabels: Record<string, MessageDescriptor> =
	Object.fromEntries(
		cloudSyncProviders.map((provider) => [provider.id, provider.versionLabel]),
	);

export function connectionTestStepLabel(
	provider: CloudSyncProvider | null,
	step: string,
): MessageDescriptor | undefined {
	return provider?.testSteps.find((item) => item.id === step)?.label;
}

export function connectionInfoLabel(
	provider: CloudSyncProvider | null,
	key: string,
): MessageDescriptor | undefined {
	return provider && Object.hasOwn(provider.infoLabels, key)
		? provider.infoLabels[key]
		: undefined;
}

export function providerFields(provider: CloudSyncProvider): SchemaField[] {
	return schemaFields(provider.schema);
}

export function providerSecretFields(provider: CloudSyncProvider): string[] {
	return secretFieldNames(provider.schema);
}

/** Fields the import modal asks (`importSchema`). */
export function importFields(provider: CloudSyncProvider): SchemaField[] {
	return schemaFields(provider.importSchema);
}

/** Fields the export modal asks (`exportSchema`). */
export function exportFields(provider: CloudSyncProvider): SchemaField[] {
	return schemaFields(provider.exportSchema);
}

export function exportSecretFields(provider: CloudSyncProvider): string[] {
	return secretFieldNames(provider.exportSchema);
}

/** What a connection test found each direction can do (null: not tested). */
export function directionCapability(
	test: {
		directions?: { direction: string; ok: boolean; reason?: unknown }[];
	} | null,
	direction: SyncDirection,
): { ok: boolean; reason?: unknown } | null {
	return test?.directions?.find((item) => item.direction === direction) ?? null;
}
