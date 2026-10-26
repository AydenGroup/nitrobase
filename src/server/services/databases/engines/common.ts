import { msg } from "@lingui/core/macro";
import type { z } from "zod";
import { APP_ID } from "#/config/shared.ts";
import type {
	DatabaseDump,
	TemplateVariableSchema,
} from "#/features/templates/schema.ts";
import { branded } from "#/libs/brand.ts";
import type { ConsoleLimits } from "../console";
import type { SqlDialect } from "../sql";

/**
 * Shared parts of the server engine drivers (pure): the driver interface,
 * the constants every engine uses and small helpers. One engine = one
 * module next to this one (postgres.ts, mysql.ts, …) registered in
 * `#/server/services/databases/engines.ts`; feature code calls the driver
 * and never branches on an engine id.
 */

export const DATABASE_SERVICE = "db";
export const DATABASE_DATA_VOLUME = "data";
/**
 * Read-only login of the SQL/Mongo console (created after each deploy):
 * Postgres role with `pg_read_all_data` (local socket only, no password),
 * MySQL/MariaDB `'nitrobase_console'@'localhost'` with SELECT only, MongoDB
 * user with `readAnyDatabase`.
 */
export const CONSOLE_ROLE = `${APP_ID}_console`;
/** Env var of the console login's password inside the container. */
export const CONSOLE_PASSWORD_ENV = `${APP_ID.toUpperCase()}_CONSOLE_PASSWORD`;
/** Logins the panel owns in an app database (never listed as the app's). */
export const CONSOLE_ROLES = [CONSOLE_ROLE] as const;

/** Names chosen at creation (identifiers, quoted anyway when used). */
const DATABASE_NAME_PATTERN = "^[a-z_][a-z0-9_]{0,30}$";

/** Container health check of every engine (start period per engine). */
const DATABASE_HEALTHCHECK = {
	interval: "5s",
	timeout: "10s",
	retries: 30,
} as const;
/** Databases flush on shutdown: time they get before SIGKILL. */
const DATABASE_STOP_GRACE_PERIOD = "60s";

export type VariableInput = z.input<typeof TemplateVariableSchema>;

/** Main login of a database (links and the Connect card use it). */
export interface DatabaseLogin {
	/** Null: password only (Valkey's `default` user). */
	user: string | null;
	password: string;
	/** Null: no default database (Valkey). */
	database: string | null;
}

export interface DatabaseEndpoint {
	host: string;
	port: number;
}

/** A command run in the database container, with its stdin. */
interface EngineCommand {
	command: string;
	input: string;
}

/** The database container a driver command runs in. */
export interface EngineTarget {
	container: string;
	/** The app's resolved values (DB_USER, DB_NAME, passwords…). */
	values: Record<string, string>;
	nonce: string;
	limits: ConsoleLimits;
}

interface ConsoleRequest {
	text: string;
	/** Null: the engine's default (no main database, e.g. Valkey). */
	database: string | null;
	readOnly: boolean;
	maxBytes: number;
	scanMaxCount: number;
}

/** A checked console run: the command, its stdin and the audit texts. */
interface ConsolePlan extends EngineCommand {
	/** Statements/commands for the audit log (literals hidden). */
	audited: string[];
}

/** What a successful console run printed, as the UI shows it. */
type ConsoleOutcome =
	| {
			kind: "grid";
			columns: string[];
			rows: (string | null)[][];
			truncated: boolean;
	  }
	| { kind: "text" | "none"; text: string }
	| { kind: "error"; error: string };

interface EngineConsole {
	/** Validate the input for the mode and build the run (coded refusals). */
	prepare(target: EngineTarget, request: ConsoleRequest): ConsolePlan;
	/** Admin SQL refreshed before each read-only run (MariaDB grants). */
	beforeReadOnly?: () => string;
	/** Output of a run that exited 0. */
	outcome(body: string, nonce: string, maxRows: number): ConsoleOutcome;
}

/** One admin statement, run as the superuser (in `database` when set). */
export interface AdminStep {
	sql: string;
	database?: string;
}

/** Users and databases management (engines with `manageUsers`). */
export interface EngineAdmin {
	dialect: SqlDialect;
	/** Client reading admin SQL on stdin as the superuser/root. */
	command(target: EngineTarget, database?: string): string;
	/** One JSON document `{databases, users}`. */
	listSql(): string;
	createDatabase(name: string, owner: string | null): AdminStep[];
	createUser(name: string, password: string): AdminStep[];
	/** `host`: account host where the engine has them (default: any). */
	grant(database: string, user: string, host?: string): AdminStep[];
	dropDatabase(name: string): AdminStep[];
	dropUser(name: string, host?: string): AdminStep[];
	/** Names the UI never drops (engine, Nitrobase or the app's own). */
	isProtected(
		kind: "database" | "user",
		name: string,
		main: { user: string; database: string },
	): boolean;
}

export interface ServerEngine {
	variables: Record<string, VariableInput>;
	/** Users the owner may not pick (the engine or Nitrobase own them). */
	reservedUsers: string[];
	/** The `db` service at image tag `tag`. */
	service(image: string, tag: string): Record<string, unknown>;
	/** Extra named volumes besides `data`. */
	extraVolumes?: string[];
	/** `[backup.database]` table (see db-strategies). */
	backup(values: Record<string, string>): DatabaseDump;
	/** Main login from the app's resolved values. */
	login(values: Record<string, string>): DatabaseLogin;
	/** `scheme://user:password@host:port/database` (`password: null`: left out). */
	connectionUrl(
		endpoint: DatabaseEndpoint,
		login: Omit<DatabaseLogin, "password"> & { password: string | null },
	): string;
	/** Shell command opening the engine's client (password prompted). */
	clientCommand(
		endpoint: DatabaseEndpoint,
		login: Omit<DatabaseLogin, "password">,
	): string;
	/** Data size: the probe and its parser (bytes, null: unreadable). */
	size: {
		probe(target: EngineTarget): EngineCommand;
		parse(stdout: string): number | null;
	};
	/**
	 * (Re)create the console's read-only login after a deploy (null: the
	 * console uses the main password). `verify`: the output proves success.
	 */
	consoleLogin(
		target: EngineTarget,
	): (EngineCommand & { verify?: (body: string) => boolean }) | null;
	/** Turn a client's error output into the message shown. */
	formatError(text: string): string;
	console: EngineConsole;
	admin?: EngineAdmin;
}

/**
 * `${NAME}`: compose interpolation of a variable, or a generator
 * (`password:32`). Joined, not a template literal: the bundler mis-renders
 * `$${…}` in this module (empty server chunk).
 */
export const v = (name: string) => ["$", "{", name, "}"].join("");

export const text = {
	user: msg({ id: "Database user" }).id,
	userHelp: msg({
		id: "Login created with the database (lowercase letters, digits and _).",
	}).id,
	name: msg({ id: "Database name" }).id,
	nameHelp: msg({ id: "First database, created empty." }).id,
	password: msg({ id: "Password" }).id,
	rootPassword: msg({ id: "Root password" }).id,
	consolePassword: msg({ id: "Console password" }).id,
	consoleHelp: branded(
		msg({
			id: "Password of the read-only login {appName}'s console uses.",
		}),
	).id,
	port: msg({ id: "Database port" }).id,
	portHelp: msg({
		id: "Publish the database on the server to connect from outside (desktop clients). Prefer 127.0.0.1 and an SSH tunnel; anything else exposes it to the network.",
	}).id,
};

export const generated = (
	label: string,
	credential: boolean,
): VariableInput => ({
	value: v("password:32"),
	label,
	secret: true,
	credential,
});

/**
 * Read by the image's entrypoint only when it initialises an empty data
 * directory (POSTGRES_*, MYSQL_*, MARIADB_*, MONGO_INITDB_*): later values
 * are ignored, so they are frozen after the first deploy (template
 * `initial_only`).
 */
export const initialGenerated = (
	label: string,
	credential: boolean,
): VariableInput => ({ ...generated(label, credential), initial_only: true });

export const userVariable: VariableInput = {
	value: "app",
	label: text.user,
	description: text.userHelp,
	editable: true,
	credential: true,
	// Created with the data directory (see `initialGenerated`).
	initial_only: true,
	pattern: DATABASE_NAME_PATTERN,
};

export const nameVariable: VariableInput = {
	value: "app",
	label: text.name,
	description: text.nameHelp,
	editable: true,
	credential: true,
	initial_only: true,
	pattern: DATABASE_NAME_PATTERN,
};

export const consolePasswordVariable: VariableInput = {
	...generated(text.consolePassword, false),
	description: text.consoleHelp,
};

export const healthcheck = (test: string, startSeconds = 30) => ({
	test: ["CMD-SHELL", test],
	...DATABASE_HEALTHCHECK,
	start_period: `${startSeconds}s`,
});

export const baseService = (image: string, tag: string) => ({
	image: `${image}:${tag}`,
	restart: "unless-stopped",
	stop_grace_period: DATABASE_STOP_GRACE_PERIOD,
});

/** Main login of engines with a user, a password and a database. */
export const userLogin = (values: Record<string, string>): DatabaseLogin => ({
	user: values.DB_USER ?? "app",
	password: values.DB_PASSWORD ?? "",
	database: values.DB_NAME ?? "app",
});

/** Percent-encode a URL component (also `!'()*`, which encodeURIComponent keeps). */
export function encodeUrlPart(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/** `host:port`, IPv6 literals bracketed. */
export function urlAuthority(endpoint: DatabaseEndpoint): string {
	const host =
		endpoint.host.includes(":") && !endpoint.host.startsWith("[")
			? `[${endpoint.host}]`
			: endpoint.host;
	return `${host}:${endpoint.port}`;
}

/** `:password` for a URL (empty when hidden). */
export const urlPassword = (password: string | null) =>
	password === null ? "" : `:${encodeUrlPart(password)}`;

/** First integer of the first output line (SQL size probes). */
export function firstInteger(stdout: string): number | null {
	const value = Number.parseInt(stdout.trim().split("\n")[0] ?? "", 10);
	return Number.isFinite(value) ? value : null;
}

/** First match of `pattern`'s group 1 as a number (key/value size probes). */
export function matchedInteger(stdout: string, pattern: RegExp): number | null {
	const match = pattern.exec(stdout);
	return match ? Number(match[1]) : null;
}
