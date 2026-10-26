import { z } from "zod";
import type { RotateHookView } from "#/features/apps/schema.ts";
import { ENV_NAME_PATTERN } from "#/libs/naming-rules.ts";

const service = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const envName = z.string().regex(ENV_NAME_PATTERN);
const role = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const fileName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
/** Only `user.*` attributes: the ones backups keep (#/config/backup-tools.ts). */
const userXattr = z.string().regex(/^user\.[A-Za-z0-9._-]{1,200}$/);
/** Header-like text without control characters. */
const headerText = z
	.string()
	.min(1)
	.max(1024)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects them
	.regex(/^[^\u0000-\u001f\u007f]+$/);

/**
 * Storage file backend (`STORAGE_BACKEND=file`): where objects live and
 * the extended attributes the storage API reads for each file. An object
 * is the file `<path>/<bucket var>/<tenant var>/<bucket_id>/<name>` +
 * `<separator><version>` (storage-api `TenantLocation` +
 * `withOptionalVersion`); its `user.*` attributes hold the content type
 * and cache control, also kept in `storage.objects.metadata`.
 */
const StorageFilesConfigSchema = z.object({
	/** Compose service of the storage API. */
	service,
	/**
	 * The storage container's env variable choosing the backend, and the
	 * value meaning "file backend": anything else (e.g. s3) has no file
	 * metadata, so the check and repair are skipped.
	 */
	backend_variable: envName,
	backend_value: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	/** App-folder path mounted as the backend root (a backup path). */
	path: z
		.string()
		.regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$/),
	/** Variables holding the backend's root bucket and tenant id. */
	bucket_variable: envName,
	tenant_variable: envName,
	/** Version separators to try, in order (`/`, or `-$v-` for TUS mode). */
	version_separators: z
		.array(z.string().regex(/^[A-Za-z0-9/$_-]{1,8}$/))
		.min(1),
	content_type_xattr: userXattr,
	cache_control_xattr: userXattr,
	/** What the storage API writes when an upload has none. */
	default_content_type: headerText,
	default_cache_control: headerText,
});
export type StorageFilesConfig = z.infer<typeof StorageFilesConfigSchema>;

/**
 * `[plugin]` section of templates/supabase/template.toml: which compose
 * services, ports, paths and variables the plugin works with.
 */
export const SupabasePluginConfigSchema = z.object({
	api_service: service,
	api_port: z.number().int().min(1).max(65535),
	studio_service: service,
	functions_service: service,
	functions_dir: z.string().regex(/^\/[A-Za-z0-9_./-]+$/),
	/** Router function folders that are not user functions (hidden, reserved). */
	functions_reserved: z.array(z.string()).default([]),
	db_service: service,
	db_user: role,
	db_name: role,
	/** Schemas listed read-only in Database Functions (view, no edit/drop). */
	db_readonly_schemas: z.array(z.string()).default([]),
	anon_key: envName,
	service_key: envName,
	jwt_secret: envName,
	/**
	 * New API keys (opaque `sb_publishable_…` / `sb_secret_…`): preferred
	 * over the legacy JWT keys when the app has values for them.
	 */
	publishable_key: envName.optional(),
	secret_key: envName.optional(),
	/** Public signing keys (JWKS) path behind the API gateway. */
	jwks_path: z
		.string()
		.regex(/^\/[A-Za-z0-9_./-]*$/)
		.optional(),
	studio_username: envName,
	studio_password: envName,
	db_password: envName,
	pooler_tenant: envName,
	/** Template `[[ports]]` ids of the pooler (for the connection string). */
	pooler_ports: z.array(z.string()).default([]),
	/** Cloud sync: services stopped while an imported database loads. */
	sync_writer_services: z.array(service).default([]),
	/** Variable holding the database port inside its container. */
	db_port_variable: envName.optional(),
	/** Storage S3 protocol behind the API gateway: path, region and keys. */
	storage_s3_path: z
		.string()
		.regex(/^\/[A-Za-z0-9_./-]*$/)
		.optional(),
	storage_region: envName.optional(),
	storage_s3_key_id: envName.optional(),
	storage_s3_key_secret: envName.optional(),
	/** pgsodium/Vault root key file in the db container, and its owner. */
	db_root_key_file: z
		.string()
		.regex(/^\/[A-Za-z0-9_./-]+$/)
		.optional(),
	db_root_key_owner: role.optional(),
	/**
	 * Cloud sync export: services stopped while the app is copied when the
	 * member asks (the storage gateway and functions keep running: the copy
	 * reads through them).
	 */
	sync_export_writer_services: z.array(service).default([]),
	/** Variable saying whether the functions runtime verifies JWTs. */
	functions_verify_jwt: envName.optional(),
	/** Entrypoint file names of a function folder, in order of preference. */
	functions_entrypoints: z.array(fileName).default([]),
	/** Import map / deno config file names of a function folder. */
	functions_import_maps: z.array(fileName).default([]),
	/** Storage file backend metadata (restore repair, on-demand repair). */
	storage_files: StorageFilesConfigSchema.optional(),
});

export type SupabasePluginConfig = z.infer<typeof SupabasePluginConfigSchema>;

const appId = z.guid();
const FunctionNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const keyChoice = z.enum(["anon", "service"]);

export const AppOnlySchema = z.object({ appId });

export const FunctionRefSchema = z.object({ appId, name: FunctionNameSchema });

export const CreateFunctionSchema = z.object({
	appId,
	name: FunctionNameSchema,
	starter: z.string().regex(/^[a-z0-9-]+$/),
});

export const SaveFunctionSchema = z.object({
	appId,
	name: FunctionNameSchema,
	files: z
		.array(
			z.object({
				path: z.string().min(1).max(200),
				content: z.string().max(2 * 1024 * 1024),
			}),
		)
		.min(1)
		.max(200),
});

/** Existing shared folders (`_shared`, or plain names such as `lib`). */
const SharedFolderNameSchema = z
	.string()
	.regex(/^(_[a-z0-9][a-z0-9_-]{0,61}|[a-z][a-z0-9_-]{0,62})$/);

export const SharedFolderRefSchema = z.object({
	appId,
	name: SharedFolderNameSchema,
});

export const SaveSharedFolderSchema = z.object({
	appId,
	name: SharedFolderNameSchema,
	files: z
		.array(
			z.object({
				path: z.string().min(1).max(200),
				content: z.string().max(2 * 1024 * 1024),
			}),
		)
		.min(1)
		.max(200),
	/** Create a new folder (name must start with `_`) instead of editing one. */
	create: z.boolean().optional(),
});

export const InvokeFunctionSchema = z.object({
	appId,
	name: FunctionNameSchema,
	method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
	body: z
		.string()
		.max(1024 * 1024)
		.optional(),
	key: keyChoice,
});

const schemaName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);

export const DbSchemaQuerySchema = z.object({ appId, schema: schemaName });

export const DbFunctionRefSchema = z.object({
	appId,
	schema: schemaName,
	oid: z.number().int().positive(),
});

export const RunSqlSchema = z.object({
	appId,
	sql: z
		.string()
		.min(1)
		.max(1024 * 1024),
	/** The user confirmed the risks of the statement (see `analyzeSqlRisk`). */
	acknowledgeRisk: z.boolean().optional(),
});

export const RunRpcSchema = z.object({
	appId,
	schema: schemaName,
	name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
	/** JSON object of named arguments. */
	args: z.string().max(1024 * 1024),
	key: keyChoice,
});

// DTOs

export interface SupabaseOverview {
	apiUrl: string | null;
	/** The template describes its storage files: the repair is available. */
	storageRepair: boolean;
	studioUrl: string | null;
	/** True when Studio has its own domain behind Nitrobase basic auth. */
	studioProtected: boolean;
	/** Public, safe for browsers (subject to RLS). */
	anonKey: string | null;
	/**
	 * New API keys: `ready` (the app has them), `redeploy` (its release has
	 * them: the next deploy generates them), `update` (an older release),
	 * `unsupported` (the template does not generate them).
	 */
	newKeys: "ready" | "redeploy" | "update" | "unsupported";
	/** Opaque publishable key (public, subject to RLS). */
	publishableKey: string | null;
	/** Variable of the opaque secret key, when the app has one. */
	secretKeyName: string | null;
	/** The secret key can be rotated on its own (template `rotatable`). */
	secretKeyRotatable: boolean;
	/** First release with the new keys (for `update`). */
	newKeysVersion: string | null;
	/** Public JWKS endpoint (Auth's signing keys) behind the gateway. */
	jwksUrl: string | null;
	/** Variable names the client may pass to the reveal / rotate actions. */
	serviceKeyName: string;
	jwtSecretName: string;
	/** The template's `on_rotate` step of the JWT secret (null: none). */
	jwtSecretRotateHook: RotateHookView | null;
	studioUsername: string | null;
	studioPasswordName: string;
	dbPasswordName: string;
	pooler: {
		label: string;
		hostPort: number;
		/** Bound on the server's 127.0.0.1: connect through an SSH tunnel. */
		loopback: boolean;
		connection: string;
	}[];
	/** Compose services the plugin tabs work with. */
	functionsService: string;
	dbService: string;
}

export interface EdgeFunctionSummary {
	name: string;
	updatedAt: string | null;
}

export interface EdgeFunctionSource {
	name: string;
	files: { path: string; content: string }[];
	skipped: string[];
}

export interface HttpResult {
	status: number | null;
	headers: [string, string][];
	body: string;
	timeMs: number | null;
	truncated: boolean;
	error: string | null;
}

export interface DbFunctionSummary {
	oid: number;
	schema: string;
	name: string;
	args: string;
	returns: string;
	language: string;
	kind: "f" | "p";
	security_definer: boolean;
	comment: string | null;
}

export interface DbSchemaSummary {
	name: string;
	readOnly: boolean;
}

export interface SqlResult {
	ok: boolean;
	output: string;
	error: string | null;
}
