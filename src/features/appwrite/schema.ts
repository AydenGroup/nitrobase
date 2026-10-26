import { z } from "zod";
import { ENV_NAME_PATTERN } from "#/libs/naming-rules.ts";

const service = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const envName = z.string().regex(ENV_NAME_PATTERN);
/** Appwrite resource / scope names (`user`, `environment-variable`, `migrations.write`). */
const token = z.string().regex(/^[a-z][a-z0-9.-]*$/);

/**
 * `[plugin]` section of templates/appwrite/template.toml: the API service
 * the panel calls inside the app, the console admin variables and what an
 * import from Appwrite Cloud copies.
 */
export const AppwritePluginConfigSchema = z.object({
	api_service: service,
	api_port: z.number().int().min(1).max(65535),
	/** API prefix (`/v1`). */
	api_path: z.string().regex(/^\/[A-Za-z0-9_-]+$/),
	/** Project id of the console (`console`). */
	console_project: z.string().regex(/^[a-z0-9-]+$/),
	/** Variables holding the console admin login an import creates. */
	console_email: envName,
	console_password: envName,
	/** Scopes of the temporary key the import creates in the new project. */
	sync_key_scopes: z.array(token).min(1),
	/**
	 * Export: scopes of the temporary key the panel creates in this app's
	 * project for the cloud to read it (read-only, by resource).
	 */
	sync_export_key_scopes: z.array(token).default([]),
	/** Export: scopes the connection's cloud key needs to run a migration. */
	sync_cloud_key_scopes: z.array(token).default([]),
	/** Migration resources (utopia-php/migration names) per import part. */
	sync_resources: z.record(
		z.string().regex(/^[a-z][a-z0-9_]*$/),
		z.array(token).min(1),
	),
});

export type AppwritePluginConfig = z.infer<typeof AppwritePluginConfigSchema>;
