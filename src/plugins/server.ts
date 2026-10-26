import type { TemplateManifest } from "#/features/templates/schema.ts";
import type { AppLocation } from "#/server/services/apps/commands.ts";
import { buildDatabaseStrategy } from "#/server/services/backup/db-strategies.ts";
import type { DatabaseStrategy } from "#/server/services/backup/strategy.ts";
import type { Executor } from "#/server/services/executor.ts";
import type { MetricCollector } from "#/server/services/monitoring/collectors.ts";
import {
	type StorageCheckJob,
	supabaseRestoreCheck,
} from "#/server/services/supabase/storage-metadata.ts";

/** What a plugin's post-restore step works with. */
export interface RestoreDataHookInput {
	executor: Executor;
	location: AppLocation;
	/** The template's `[plugin]` config. */
	pluginConfig: unknown;
	/** The restored app's resolved env values (secrets: server-only). */
	values: Record<string, string>;
	/** The per-server backup tools image (built already). */
	toolsImage: string;
	container: (service: string) => string;
	job: StorageCheckJob;
}

/**
 * Server-only parts of provider plugins (kept out of the client registry).
 * Each factory receives the template's `[plugin]` config.
 */
export interface ServerPlugin {
	databaseStrategy?: (pluginConfig: unknown) => DatabaseStrategy;
	/**
	 * App-specific metric collectors, run on servers that host an app of
	 * this template (in the same tick command as the built-in ones).
	 */
	collectors?: MetricCollector[];
	/**
	 * After a restore (overwrite, clone, move) loaded the files and the
	 * database, app stopped and its database service up: check or repair
	 * data an archive may lack (e.g. extended attributes of archives made
	 * before backups kept them). A failure is a job warning, not a failed
	 * restore.
	 */
	afterRestoreData?: (input: RestoreDataHookInput) => Promise<void>;
}

export const serverPlugins: Record<string, ServerPlugin> = {
	supabase: { afterRestoreData: supabaseRestoreCheck },
	appwrite: {},
};

/** A database strategy plus the archive strategy ids it can restore. */
export type ResolvedDatabaseStrategy = DatabaseStrategy & { accepts: string[] };

/**
 * The dump strategy of a template's `[backup].database`: a generic one from
 * the registry (table form), or the provider plugin's (service name form).
 */
export function databaseStrategyFor(
	templateId: string,
	manifest: Pick<TemplateManifest, "backup" | "plugin">,
): ResolvedDatabaseStrategy | null {
	const database = manifest.backup.database;
	if (!database) return null;
	if (typeof database !== "string") return buildDatabaseStrategy(database);
	const strategy =
		serverPlugins[templateId]?.databaseStrategy?.(manifest.plugin) ?? null;
	return strategy ? { ...strategy, accepts: [strategy.id] } : null;
}

/** Plugin collectors for the templates deployed on a server. */
export function pluginCollectors(
	templateIds: ReadonlySet<string>,
): MetricCollector[] {
	return [...templateIds].flatMap(
		(templateId) => serverPlugins[templateId]?.collectors ?? [],
	);
}
