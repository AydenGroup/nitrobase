import type { CronJobMode, SyncPart } from "#/config/cloud-sync.ts";
import { asList, type ErrorInfo } from "#/libs/coded.ts";
import { coded } from "#/utils/error.ts";
import { diskBlocker } from "./preflight";

/**
 * Supabase: what a preflight found, turned into blockers (the import refuses to
 * start) and warnings (shown before confirming, kept in the summary).
 * Pure: the facts are gathered by the provider driver.
 */
export interface PreflightFacts {
	parts: SyncPart[];
	sourceMajor: number | null;
	/** The app's Postgres major (null: unknown until it runs). */
	targetMajor: number | null;
	databaseBytes: number;
	storageBytes: number;
	/** Free bytes on the target (null: unknown). */
	freeDiskBytes: number | null;
	diskFactor: number;
	vaultSecrets: number;
	/** The project's encryption key can be copied (secrets stay readable). */
	rootKeyAvailable: boolean;
	extensions: string[];
	/** Cron jobs, triggers or functions that call the cloud domain. */
	cloudReferences: string[];
	customRoles: string[];
	functionsWithoutJwt: string[];
	functionCount: number;
	tlsVerified: boolean;
	hasStorageKeys: boolean;
	/** pg_cron jobs of the cloud database, and what the import does with them. */
	cronJobs: number;
	cronMode: CronJobMode;
}

/** What happens to the source's pg_cron jobs (none: no warning). */
function cronWarning(count: number, mode: CronJobMode): ErrorInfo[] {
	return count > 0 ? [coded("CLOUD_WARN_CRON_JOBS", { count, mode })] : [];
}

export interface PreflightAnalysis {
	blockers: ErrorInfo[];
	warnings: ErrorInfo[];
	requiredDiskBytes: number;
}

/** Extensions every Supabase database has (not worth listing). */
const BASE_EXTENSIONS = new Set([
	"plpgsql",
	"pgcrypto",
	"uuid-ossp",
	"pg_stat_statements",
	"pg_graphql",
	"supabase_vault",
	"pgsodium",
]);

export function analyzePreflight(facts: PreflightFacts): PreflightAnalysis {
	const blockers: ErrorInfo[] = [];
	const warnings: ErrorInfo[] = [];
	const has = (part: SyncPart) => facts.parts.includes(part);
	if (facts.parts.length === 0) blockers.push(coded("CLOUD_SYNC_PARTS_EMPTY"));
	if (has("database")) {
		if (facts.sourceMajor === null) {
			blockers.push(coded("CLOUD_SYNC_VERSION_UNKNOWN"));
		} else if (
			facts.targetMajor !== null &&
			facts.sourceMajor > facts.targetMajor
		) {
			blockers.push(
				coded("CLOUD_SYNC_VERSION_DOWNGRADE", {
					source: facts.sourceMajor,
					target: facts.targetMajor,
				}),
			);
		}
	}
	const copied =
		(has("database") ? facts.databaseBytes : 0) +
		(has("storage") && facts.hasStorageKeys ? facts.storageBytes : 0);
	const requiredDiskBytes = Math.ceil(copied * facts.diskFactor);
	const disk = diskBlocker(requiredDiskBytes, facts.freeDiskBytes);
	if (disk) blockers.push(disk);

	warnings.push(coded("CLOUD_WARN_KEYS_CHANGE"));
	if (has("database")) {
		warnings.push(coded("CLOUD_WARN_SESSIONS"));
		if (facts.vaultSecrets > 0) {
			warnings.push(
				facts.rootKeyAvailable
					? coded("CLOUD_WARN_VAULT_KEY_COPIED", { count: facts.vaultSecrets })
					: coded("CLOUD_WARN_VAULT_UNREADABLE", {
							count: facts.vaultSecrets,
						}),
			);
		}
		const extensions = facts.extensions.filter(
			(name) => !BASE_EXTENSIONS.has(name),
		);
		if (extensions.length) {
			warnings.push(
				coded("CLOUD_WARN_EXTENSIONS", { names: asList(extensions.sort()) }),
			);
		}
		if (facts.customRoles.length) {
			warnings.push(
				coded("CLOUD_WARN_ROLE_PASSWORDS", {
					roles: asList(facts.customRoles),
				}),
			);
		}
		warnings.push(...cronWarning(facts.cronJobs, facts.cronMode));
		if (facts.cloudReferences.length) {
			warnings.push(
				coded("CLOUD_WARN_CLOUD_REFERENCES", {
					items: asList(facts.cloudReferences),
				}),
			);
		}
		if (!facts.tlsVerified) warnings.push(coded("CLOUD_WARN_TLS_UNVERIFIED"));
	}
	if (has("storage") && !facts.hasStorageKeys) {
		warnings.push(coded("CLOUD_WARN_STORAGE_NO_KEYS"));
	}
	if (has("functions") && facts.functionCount > 0) {
		warnings.push(coded("CLOUD_WARN_FUNCTION_SECRETS"));
		if (facts.functionsWithoutJwt.length) {
			warnings.push(
				coded("CLOUD_WARN_FUNCTIONS_VERIFY_JWT", {
					names: asList(facts.functionsWithoutJwt),
				}),
			);
		}
	}
	warnings.push(coded("CLOUD_WARN_NOT_SYNCED"));
	return { blockers, warnings, requiredDiskBytes };
}

/** Postgres major of a compose service's image tag (`supabase/postgres:17.6.1.136`). */
export function imageMajor(image: string | undefined | null): number | null {
	const tag = image?.split(":").at(-1) ?? "";
	const match = /^(\d+)(?:\.|$|-)/.exec(tag);
	const major = match ? Number(match[1]) : Number.NaN;
	return Number.isInteger(major) && major >= 9 && major < 100 ? major : null;
}

// ---------------------------------------------------------------------------
// Export (the app → an empty cloud project)

/** What the cloud project already holds (an export needs all of it empty). */
export interface CloudContents {
	/** Tables, views and other relations in user schemas (`schema.name`). */
	relations: string[];
	/** Functions in user schemas (`schema.name`), not owned by extensions. */
	functions: string[];
	users: number;
	buckets: number;
	objects: number;
	vaultSecrets: number;
	/** Edge function slugs (Management API). */
	edgeFunctions: string[];
}

/** Most names an emptiness blocker lists. */
const MAX_LISTED = 10;

/**
 * What makes a cloud project non-empty, as identifiers for the blocker
 * (`schema.table`, `auth.users: 3`, edge function slugs); empty: empty.
 */
export function cloudContentItems(cloud: CloudContents): string[] {
	const items = [
		...cloud.relations,
		...cloud.functions.map((name) => `${name}()`),
		...(cloud.users > 0 ? [`auth.users: ${cloud.users}`] : []),
		...(cloud.buckets > 0 ? [`storage.buckets: ${cloud.buckets}`] : []),
		...(cloud.objects > 0 ? [`storage.objects: ${cloud.objects}`] : []),
		...(cloud.vaultSecrets > 0 ? [`vault.secrets: ${cloud.vaultSecrets}`] : []),
		...cloud.edgeFunctions.map((slug) => `functions/${slug}`),
	];
	return items.length > MAX_LISTED
		? [...items.slice(0, MAX_LISTED), "…"]
		: items;
}

export interface ExportFacts {
	parts: SyncPart[];
	/** The app's Postgres major (null: unknown). */
	localMajor: number | null;
	/** The cloud project's Postgres major (null: unknown). */
	cloudMajor: number | null;
	cloud: CloudContents;
	/** The connection's database user may create roles and tables. */
	canWrite: boolean;
	databaseBytes: number;
	freeDiskBytes: number | null;
	diskFactor: number;
	hasStorageKeys: boolean;
	/** Vault secrets of the app (never copied: the cloud has its own key). */
	vaultSecrets: number;
	/** Extensions the app uses that the cloud project does not offer. */
	extensionsMissing: string[];
	customRoles: string[];
	functionCount: number;
	/** The app's functions run without JWT verification. */
	functionsWithoutJwt: boolean;
	/** Services stopped during the copy (empty: the app keeps running). */
	stoppedWriters: string[];
	tlsVerified: boolean;
	/** The export's staging schema prefix, and the app's schemas using it. */
	stagingPrefix: string;
	stagingTaken: string[];
	/** pg_cron jobs of the app, and what the export does with them. */
	cronJobs: number;
	cronMode: CronJobMode;
}

/** Blockers and warnings of an export (pure). */
export function analyzeExportPreflight(facts: ExportFacts): PreflightAnalysis {
	const blockers: ErrorInfo[] = [];
	const warnings: ErrorInfo[] = [];
	const has = (part: SyncPart) => facts.parts.includes(part);
	if (facts.parts.length === 0) blockers.push(coded("CLOUD_SYNC_PARTS_EMPTY"));
	const items = cloudContentItems(facts.cloud);
	if (items.length > 0) {
		blockers.push(coded("CLOUD_EXPORT_NOT_EMPTY", { items: asList(items) }));
	}
	if (!facts.canWrite) blockers.push(coded("CLOUD_EXPORT_DB_READ_ONLY"));
	if (facts.stagingTaken.length > 0) {
		// They would be copied into the cloud where the job stages owners.
		blockers.push(
			coded("CLOUD_EXPORT_STAGING_SCHEMA_TAKEN", {
				prefix: facts.stagingPrefix,
				schemas: asList(facts.stagingTaken),
			}),
		);
	}
	if (has("database")) {
		if (facts.localMajor === null || facts.cloudMajor === null) {
			blockers.push(coded("CLOUD_SYNC_VERSION_UNKNOWN"));
		} else if (facts.localMajor > facts.cloudMajor) {
			blockers.push(
				coded("CLOUD_EXPORT_POSTGRES_NEWER", {
					source: facts.localMajor,
					target: facts.cloudMajor,
				}),
			);
		}
	}
	if (has("storage") && !facts.hasStorageKeys) {
		blockers.push(coded("CLOUD_EXPORT_STORAGE_NO_KEYS"));
	}
	// The dumps are staged on the app's server; files stream through.
	const requiredDiskBytes = has("database")
		? Math.ceil(facts.databaseBytes * facts.diskFactor)
		: 0;
	const disk = diskBlocker(requiredDiskBytes, facts.freeDiskBytes);
	if (disk) blockers.push(disk);

	warnings.push(coded("CLOUD_WARN_EXPORT_KEYS_CHANGE"));
	if (has("database")) {
		warnings.push(coded("CLOUD_WARN_SESSIONS"));
		warnings.push(coded("CLOUD_WARN_EXPORT_PLATFORM_SCHEMAS"));
		if (facts.vaultSecrets > 0) {
			warnings.push(
				coded("CLOUD_WARN_EXPORT_VAULT", { count: facts.vaultSecrets }),
			);
		}
		warnings.push(...cronWarning(facts.cronJobs, facts.cronMode));
		if (facts.extensionsMissing.length) {
			warnings.push(
				coded("CLOUD_WARN_EXPORT_EXTENSIONS_MISSING", {
					names: asList([...facts.extensionsMissing].sort()),
				}),
			);
		}
		if (facts.customRoles.length) {
			warnings.push(
				coded("CLOUD_WARN_ROLE_PASSWORDS", {
					roles: asList(facts.customRoles),
				}),
			);
		}
		if (!facts.tlsVerified) warnings.push(coded("CLOUD_WARN_TLS_UNVERIFIED"));
	}
	if (has("functions") && facts.functionCount > 0) {
		warnings.push(coded("CLOUD_WARN_EXPORT_FUNCTION_SECRETS"));
		if (facts.functionsWithoutJwt) {
			warnings.push(coded("CLOUD_WARN_EXPORT_FUNCTIONS_NO_JWT"));
		}
	}
	warnings.push(
		facts.stoppedWriters.length > 0
			? coded("CLOUD_WARN_EXPORT_WRITERS_STOPPED", {
					services: asList(facts.stoppedWriters),
				})
			: coded("CLOUD_WARN_EXPORT_LIVE_WRITES"),
	);
	warnings.push(coded("CLOUD_WARN_EXPORT_NOT_SYNCED"));
	return { blockers, warnings, requiredDiskBytes };
}
