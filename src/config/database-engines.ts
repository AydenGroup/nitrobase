import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { RollbackMode } from "#/server/services/app-updates/policy.ts";

/**
 * Standalone database engines (client-safe registry, R3 M2). A database is
 * an app whose source kind is `database` (#/config/app-sources.ts): the
 * compose file, health check, backup strategy, connection strings, size
 * probe, console and users management of each engine are its server
 * driver (`#/server/services/databases/engines/<engine>.ts`, registered
 * in `#/server/services/databases/engines.ts`). Adding an engine = an id
 * in `DATABASE_ENGINE_IDS`, an entry here and a driver module there; no
 * other code branches on engine ids (guarded by registry-guard.test.ts).
 *
 * Versions are pinned image tags (newest first; `defaultVersion` is what
 * the create form offers). An app stores its engine and tag together as
 * its version, `<engine>@<tag>` (see `databaseVersionRef`), so backups,
 * restores, clones and moves carry them like any template version.
 */
/** Template of every database app (`templates/database`). */
export const DATABASE_TEMPLATE_ID = "database";

export const DATABASE_ENGINE_IDS = [
	"postgres",
	"mysql",
	"mariadb",
	"valkey",
	"mongodb",
] as const;

export type DatabaseEngineId = (typeof DATABASE_ENGINE_IDS)[number];

/** What the console of an engine runs. */
export type DatabaseConsoleKind = "sql" | "redis" | "mongo";

export interface DatabaseConsoleKindDefinition {
	title: MessageDescriptor;
	description: MessageDescriptor;
	/** Placeholder of the input (a technical example, not translated). */
	example: string;
	/** Height of the input (one command vs. a script). */
	minRows: number;
	/** The run targets a database the user may pick. */
	picksDatabase: boolean;
}

/** Console UI of each kind (the server side is the engine driver). */
export const databaseConsoleKinds = {
	sql: {
		title: msg({ id: "SQL console" }),
		description: msg({
			id: "Runs as a read-only login inside a READ ONLY transaction, with a statement timeout. Only the last statement's result is shown.",
		}),
		example:
			"SELECT table_schema, table_name FROM information_schema.tables LIMIT 20;",
		minRows: 5,
		picksDatabase: true,
	},
	redis: {
		title: msg({ id: "Command console" }),
		description: msg({
			id: "One command per run. Read-only mode allows reading commands only (use SCAN, not KEYS).",
		}),
		example: "SCAN 0 COUNT 100",
		minRows: 1,
		picksDatabase: false,
	},
	mongo: {
		title: msg({ id: "Command console" }),
		description: msg({
			id: 'One command document per run, as JSON, e.g. {"find": "users", "filter": {}, "limit": 20}. Read-only mode allows reading commands only.',
		}),
		example: '{"listCollections": 1, "nameOnly": true}',
		minRows: 5,
		picksDatabase: true,
	},
} as const satisfies Record<DatabaseConsoleKind, DatabaseConsoleKindDefinition>;

/**
 * In-place version changes: `patch` (same major line only: a new major
 * needs a dump and restore into a new database), `forward` (any newer
 * version; the image upgrades its data files on start).
 */
type DatabaseUpgradePolicy = "patch" | "forward";

export interface DatabaseEngineVersion {
	/** Docker image tag. */
	tag: string;
	/** Major line the tag belongs to (in-place upgrades stay within it for `patch`). */
	major: string;
}

export interface DatabaseEngineDefinition {
	/** Product name (not translated). */
	name: string;
	description: MessageDescriptor;
	/** Licence of the server software (SPDX id or name), shown on the create form. */
	license: string;
	/** Licence remark (e.g. SSPL restrictions), when there is one. */
	licenseNote?: MessageDescriptor;
	/** Mantine color of the engine badge/icon. */
	color: string;
	/** Docker image (official). */
	image: string;
	versions: readonly DatabaseEngineVersion[];
	defaultVersion: string;
	/** Port inside the container (also the suggested published port). */
	port: number;
	console: DatabaseConsoleKind;
	/** Databases and users can be managed from the UI. */
	manageUsers: boolean;
	/** A database created from the UI can be given an owner login. */
	databaseOwner: boolean;
	/** Default login (null: the engine has a single password, e.g. Valkey). */
	defaultUser: string | null;
	/** Default database (null: none, e.g. Valkey numbered databases). */
	defaultDatabase: string | null;
	/** Command line client inside the container (Connect card hint). */
	cli: string;
	/** Env vars a linked app gets by default (URL first). */
	linkEnv: {
		url: string;
		/** Engine-specific names of the URL parts (optional, opt-in per link). */
		parts: Partial<Record<DatabaseUrlPart, string>>;
	};
	/** Suggested memory limit (MiB) of a new database. */
	memoryMb: number;
	upgrade: DatabaseUpgradePolicy;
	/**
	 * How a failed version update is undone (R4 M4): `redeploy` the old
	 * image (data files are still readable by it: patch updates), or
	 * `restore` the backup taken first (the new image upgrades data files
	 * on start, so the old one may not read them).
	 */
	rollback: RollbackMode;
}

/** Connection string parts a link can expose as separate env vars. */
export const DATABASE_URL_PARTS = [
	"host",
	"port",
	"user",
	"password",
	"database",
] as const;
export type DatabaseUrlPart = (typeof DATABASE_URL_PARTS)[number];

export const databaseUrlPartLabels = {
	host: msg({ id: "Host" }),
	port: msg({ id: "Port" }),
	user: msg({ id: "User" }),
	password: msg({ id: "Password" }),
	database: msg({ id: "Database" }),
} satisfies Record<DatabaseUrlPart, MessageDescriptor>;

export const databaseEngines = {
	postgres: {
		name: "PostgreSQL",
		description: msg({
			id: "The relational database most apps expect. Extensions, JSON, full-text search.",
		}),
		license: "PostgreSQL",
		color: "blue",
		image: "postgres",
		versions: [
			{ tag: "18.6", major: "18" },
			{ tag: "17.11", major: "17" },
			{ tag: "16.15", major: "16" },
			{ tag: "15.19", major: "15" },
			{ tag: "14.24", major: "14" },
		],
		defaultVersion: "18.6",
		port: 5432,
		console: "sql",
		manageUsers: true,
		databaseOwner: true,
		defaultUser: "app",
		defaultDatabase: "app",
		cli: "psql",
		linkEnv: {
			url: "DATABASE_URL",
			parts: {
				host: "PGHOST",
				port: "PGPORT",
				user: "PGUSER",
				password: "PGPASSWORD",
				database: "PGDATABASE",
			},
		},
		memoryMb: 512,
		upgrade: "patch",
		rollback: "redeploy",
	},
	mysql: {
		name: "MySQL",
		description: msg({
			id: "Oracle's MySQL server (LTS and innovation releases).",
		}),
		license: "GPL-2.0",
		color: "cyan",
		image: "mysql",
		versions: [
			{ tag: "8.4.11", major: "8.4" },
			{ tag: "9.7.2", major: "9.7" },
		],
		defaultVersion: "8.4.11",
		port: 3306,
		console: "sql",
		manageUsers: true,
		databaseOwner: false,
		defaultUser: "app",
		defaultDatabase: "app",
		cli: "mysql",
		linkEnv: {
			url: "DATABASE_URL",
			parts: {
				host: "MYSQL_HOST",
				port: "MYSQL_PORT",
				user: "MYSQL_USER",
				password: "MYSQL_PASSWORD",
				database: "MYSQL_DATABASE",
			},
		},
		memoryMb: 768,
		upgrade: "patch",
		rollback: "redeploy",
	},
	mariadb: {
		name: "MariaDB",
		description: msg({
			id: "Community fork of MySQL, compatible with most MySQL apps.",
		}),
		license: "GPL-2.0",
		color: "teal",
		image: "mariadb",
		versions: [
			{ tag: "11.8.9", major: "11.8" },
			{ tag: "11.4.13", major: "11.4" },
			{ tag: "10.11.19", major: "10.11" },
		],
		defaultVersion: "11.8.9",
		port: 3306,
		console: "sql",
		manageUsers: true,
		databaseOwner: false,
		defaultUser: "app",
		defaultDatabase: "app",
		cli: "mariadb",
		linkEnv: {
			url: "DATABASE_URL",
			parts: {
				host: "MYSQL_HOST",
				port: "MYSQL_PORT",
				user: "MYSQL_USER",
				password: "MYSQL_PASSWORD",
				database: "MYSQL_DATABASE",
			},
		},
		memoryMb: 512,
		upgrade: "forward",
		rollback: "restore",
	},
	valkey: {
		name: "Valkey",
		description: msg({
			id: "Redis-compatible in-memory key-value store (BSD licensed, Linux Foundation). Works with Redis clients.",
		}),
		license: "BSD-3-Clause",
		color: "red",
		image: "valkey/valkey",
		versions: [
			{ tag: "9.1.2", major: "9.1" },
			{ tag: "9.0.6", major: "9.0" },
			{ tag: "8.1.10", major: "8.1" },
		],
		defaultVersion: "9.1.2",
		port: 6379,
		console: "redis",
		manageUsers: false,
		databaseOwner: false,
		defaultUser: null,
		defaultDatabase: null,
		cli: "valkey-cli",
		linkEnv: {
			url: "REDIS_URL",
			parts: {
				host: "REDIS_HOST",
				port: "REDIS_PORT",
				password: "REDIS_PASSWORD",
			},
		},
		memoryMb: 256,
		upgrade: "forward",
		rollback: "restore",
	},
	mongodb: {
		name: "MongoDB",
		description: msg({
			id: "Document database (official Community Server image).",
		}),
		license: "SSPL-1.0",
		licenseNote: msg({
			id: "MongoDB Community Server is licensed under the SSPL: free to run for your own apps, but offering MongoDB itself as a service to third parties has obligations. It is not an OSI open-source licence.",
		}),
		color: "green",
		image: "mongo",
		versions: [
			{ tag: "8.0.32", major: "8.0" },
			{ tag: "9.0.2", major: "9.0" },
		],
		defaultVersion: "8.0.32",
		port: 27017,
		console: "mongo",
		manageUsers: false,
		databaseOwner: false,
		defaultUser: "app",
		defaultDatabase: "app",
		cli: "mongosh",
		linkEnv: {
			url: "MONGODB_URL",
			parts: {
				host: "MONGODB_HOST",
				port: "MONGODB_PORT",
				user: "MONGODB_USER",
				password: "MONGODB_PASSWORD",
				database: "MONGODB_DATABASE",
			},
		},
		memoryMb: 768,
		upgrade: "patch",
		rollback: "redeploy",
	},
} as const satisfies Record<DatabaseEngineId, DatabaseEngineDefinition>;

function isDatabaseEngine(value: unknown): value is DatabaseEngineId {
	return (
		typeof value === "string" &&
		(DATABASE_ENGINE_IDS as readonly string[]).includes(value)
	);
}

export function databaseEngine(id: DatabaseEngineId): DatabaseEngineDefinition {
	return databaseEngines[id];
}

/** App version of a database: `<engine>@<tag>`, e.g. `postgres@18.6`. */
export function databaseVersionRef(
	engine: DatabaseEngineId,
	tag: string,
): string {
	return `${engine}@${tag}`;
}

/** Engine and image tag of a database app's version (null: not one). */
export function parseDatabaseVersion(
	version: string,
): { engine: DatabaseEngineId; tag: string } | null {
	const at = version.indexOf("@");
	if (at <= 0) return null;
	const engine = version.slice(0, at);
	const tag = version.slice(at + 1);
	if (!isDatabaseEngine(engine)) return null;
	if (!/^[0-9][A-Za-z0-9._-]{0,63}$/.test(tag)) return null;
	return { engine, tag };
}

/** The registry entry of a tag (null: not offered, e.g. removed later). */
export function engineVersion(
	engine: DatabaseEngineId,
	tag: string,
): DatabaseEngineVersion | null {
	return (
		databaseEngines[engine].versions.find((item) => item.tag === tag) ?? null
	);
}

/** Numeric comparison of dotted versions (`8.4.11` vs `9.7.2`). */
export function compareVersionTags(a: string, b: string): number {
	const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
	const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Major line of a tag, also for tags no longer listed (the registry moves
 * on to newer patches): the listed major the tag starts with.
 */
export function majorOf(engine: DatabaseEngineId, tag: string): string | null {
	const listed = databaseEngines[engine].versions.find(
		(version) => version.tag === tag || tag.startsWith(`${version.major}.`),
	);
	return listed?.major ?? null;
}

/**
 * Whether a running database may change from `from` to `to` in place:
 * never down, and within the major line for `patch` engines.
 */
export function canUpgradeInPlace(
	engine: DatabaseEngineId,
	from: string,
	to: string,
): boolean {
	const target = engineVersion(engine, to);
	if (!target || compareVersionTags(to, from) <= 0) return false;
	if (databaseEngines[engine].upgrade === "forward") return true;
	return target.major === majorOf(engine, from);
}

/** Versions a database at `from` can move to in place (newest first). */
export function upgradeTargets(
	engine: DatabaseEngineId,
	from: string,
): DatabaseEngineVersion[] {
	return databaseEngines[engine].versions.filter((version) =>
		canUpgradeInPlace(engine, from, version.tag),
	);
}
