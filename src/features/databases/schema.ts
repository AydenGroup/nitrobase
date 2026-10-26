import type { I18n } from "@lingui/core";
import { z } from "zod";
import {
	DATABASE_ENGINE_IDS,
	DATABASE_URL_PARTS,
	type DatabaseConsoleKind,
	type DatabaseEngineId,
	type DatabaseUrlPart,
} from "#/config/database-engines.ts";
import { NAME_MAX_LENGTH } from "#/config/shared.ts";
import type { AppStatus } from "#/features/apps/schema.ts";
import { ENV_NAME_PATTERN } from "#/libs/naming-rules.ts";

/** Standalone databases (R3 M2): inputs and views. */

const tag = z.string().regex(/^[0-9][A-Za-z0-9._-]{0,63}$/);
/** Login/database names chosen at creation (DATABASE_NAME_PATTERN server side). */
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,30}$/);
/** Names of databases/users managed from the UI. */
const managedDatabase = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$-]{0,63}$/);
const managedUser = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/);
const mysqlHost = z.string().regex(/^(%|localhost|[A-Za-z0-9_.:%-]{1,255})$/);

export const CreateDatabaseSchema = (i18n: I18n) =>
	z.object({
		serverId: z.guid({ message: i18n._("Select a server") }),
		name: z
			.string()
			.trim()
			.min(1, { message: i18n._("Name is required") })
			.max(NAME_MAX_LENGTH),
		engine: z.enum(DATABASE_ENGINE_IDS),
		version: tag,
		user: identifier.optional().or(z.literal("").transform(() => undefined)),
		database: identifier
			.optional()
			.or(z.literal("").transform(() => undefined)),
		/** Memory limit (MiB); default: the engine's suggestion. */
		memoryMb: z.number().int().min(64).max(1_048_576).optional(),
	});
export type CreateDatabaseInput = z.infer<
	ReturnType<typeof CreateDatabaseSchema>
>;

export const DatabaseIdSchema = z.guid();

export const UpgradeDatabaseSchema = z.object({
	databaseId: z.guid(),
	version: tag,
	/** Back up (policy destination) before changing the version. */
	backupFirst: z.boolean().default(true),
});

export const RevealDatabaseSchema = z.object({
	databaseId: z.guid(),
	/** Which endpoint's connection string. */
	endpoint: z.enum(["internal", "external"]),
});

export const LinkDatabaseSchema = z.object({
	databaseId: z.guid(),
	appId: z.guid(),
	/** Name of the URL variable (default: the engine's, e.g. DATABASE_URL). */
	urlEnv: z.string().regex(ENV_NAME_PATTERN),
	/** Also set host/port/user/password/database variables under these names. */
	parts: z
		.partialRecord(
			z.enum(DATABASE_URL_PARTS),
			z.string().regex(ENV_NAME_PATTERN),
		)
		.default({}),
	/** Database the URL points at (default: the database's own). */
	database: managedDatabase.optional(),
	/** Another login (created under Users & databases); default: the main one. */
	username: managedUser.optional(),
	password: z.string().min(1).max(200).optional(),
	/** Redeploy the app now (when running) so it gets the env. */
	redeploy: z.boolean().default(true),
});
export type LinkDatabaseInput = z.infer<typeof LinkDatabaseSchema>;

export const UnlinkDatabaseSchema = z.object({
	linkId: z.guid(),
	redeploy: z.boolean().default(true),
});

export const ConsoleRunSchema = z.object({
	databaseId: z.guid(),
	/** SQL, a Redis command line or a MongoDB command document (JSON). */
	input: z
		.string()
		.min(1)
		.max(256 * 1024),
	/** Database to run in (SQL/Mongo; default: the database's own). */
	database: managedDatabase.optional(),
	/** Write mode (needs database.write; audited). */
	write: z.boolean().default(false),
});
export type ConsoleRunInput = z.infer<typeof ConsoleRunSchema>;

export const CreateManagedDatabaseSchema = z.object({
	databaseId: z.guid(),
	name: managedDatabase,
	/** Postgres: owner role (default: none). */
	owner: managedUser.optional(),
});

export const CreateManagedUserSchema = z.object({
	databaseId: z.guid(),
	name: managedUser,
	/** Grant everything on this database right away. */
	grantDatabase: managedDatabase.optional(),
});

export const GrantSchema = z.object({
	databaseId: z.guid(),
	user: managedUser,
	/** MySQL account host (default `%`). */
	host: mysqlHost.optional(),
	database: managedDatabase,
});

export const DropManagedSchema = z.object({
	databaseId: z.guid(),
	kind: z.enum(["database", "user"]),
	name: z.string().min(1).max(64),
	host: mysqlHost.optional(),
	/** The name typed again. */
	confirm: z.string(),
});

// ---------------------------------------------------------------------------
// Views

export interface DatabaseListItem {
	id: string;
	name: string;
	engine: DatabaseEngineId;
	tag: string;
	status: AppStatus;
	needsRedeploy: boolean;
	serverId: string;
	serverName: string;
	/** Linked apps. */
	links: number;
	/** The port is published on the server. */
	exposed: boolean;
	createdAt: Date;
}

export interface DatabaseEndpointView {
	host: string;
	port: number;
	/** Connection URL with the password left out. */
	url: string;
	/** Client command (prompts for the password). */
	command: string;
}

export interface DatabaseLinkView {
	id: string;
	databaseId: string;
	databaseName: string;
	databaseEngine: DatabaseEngineId;
	appId: string;
	appName: string;
	appStatus: AppStatus;
	/** The app still has to be redeployed to pick up a link change. */
	appNeedsRedeploy: boolean;
	env: { name: string; part: "url" | DatabaseUrlPart }[];
	database: string | null;
	username: string | null;
	createdAt: Date;
}

export interface DatabaseOverview {
	id: string;
	name: string;
	engine: DatabaseEngineId;
	tag: string;
	status: AppStatus;
	consoleKind: DatabaseConsoleKind;
	manageUsers: boolean;
	server: { id: string; name: string; host: string };
	/** Main login (password via reveal). */
	user: string | null;
	database: string | null;
	/** From linked apps (container name on the link network). */
	internal: DatabaseEndpointView;
	/** Published port, when enabled. */
	external:
		| (DatabaseEndpointView & { loopback: boolean; tunnel: string | null })
		| null;
	links: DatabaseLinkView[];
	/** Versions this database can move to in place. */
	upgradeTargets: string[];
	sizeBytes: number | null;
}

export interface ConsoleResult {
	kind: "grid" | "text" | "none";
	columns: string[];
	rows: (string | null)[][];
	/** Raw output (Redis/Mongo, or SQL without a result set). */
	text: string;
	truncated: boolean;
	/** Error output of the client (statement failed). */
	error: string | null;
	durationMs: number;
}

interface ManagedDatabase {
	name: string;
	owner?: string;
	sizeBytes: number;
	protected: boolean;
	/** A link to an app uses it (unlink before dropping). */
	linked: boolean;
}

export interface ManagedUser {
	name: string;
	host?: string;
	superuser?: boolean;
	login?: boolean;
	protected: boolean;
	/** A link to an app logs in with it (unlink before dropping). */
	linked: boolean;
}

export interface UsersView {
	databases: ManagedDatabase[];
	users: ManagedUser[];
}
