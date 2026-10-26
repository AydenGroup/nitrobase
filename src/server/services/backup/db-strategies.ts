import { z } from "zod";
import { hiddenFileName, resourceName } from "#/config/identifiers.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import {
	assertContainer,
	assertRole,
	type DatabaseStrategy,
	postgresStrategy,
} from "./strategy";

/**
 * Generic database dump strategies, referenced from template.toml:
 *
 * ```toml
 * [backup.database]
 * type = "postgres"        # registry key below
 * service = "db"           # compose service
 * user = "postgres"        # strategy-specific keys (validated by `params`)
 * ```
 *
 * Every strategy streams the dump on stdout of `docker exec` and restores it
 * from stdin into a freshly initialised database. Credentials never appear
 * on a command line: strategies that need a password read it from an
 * environment variable *inside* the database container (`password_env`).
 * Adding a database = one entry here.
 */
interface DatabaseStrategyDefinition<S extends z.ZodType = z.ZodType> {
	/** Template keys besides `type`, `service`, `legacy_ids`. */
	params: S;
	build(params: z.infer<S>): DatabaseStrategy;
}

/** `$VAR` name of an environment variable inside the container. */
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const role = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const dbName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/);
const absoluteFile = z
	.string()
	.regex(/^\/[\w./-]+$/)
	.refine((value) => !value.split("/").includes(".."), "no ..");

function define<S extends z.ZodType>(
	definition: DatabaseStrategyDefinition<S>,
): DatabaseStrategyDefinition {
	return definition as unknown as DatabaseStrategyDefinition;
}

const postgres = define({
	params: z.object({
		/** Superuser (local socket, no password inside the container). */
		user: role.default("postgres"),
		/** Database psql connects to (and the only one dumped in `database` mode). */
		database: dbName.default("postgres"),
		/**
		 * `cluster`: roles + every database (pg_dumpall globals + pg_dump each).
		 * `database`: only `database` (pg_dump --clean).
		 */
		mode: z.enum(["cluster", "database"]).default("cluster"),
		/** Database that always exists (restore creates `database` from it). */
		maintenance_database: dbName.default("postgres"),
		/**
		 * `database` mode: restore in one transaction and fail on the first
		 * SQL error. Default: errors are counted, the restore finishes with
		 * warnings.
		 */
		strict: z.boolean().default(false),
	}),
	build: (params) => {
		if (params.mode === "cluster") {
			return postgresStrategy({
				id: "postgres-cluster",
				user: params.user,
				database: params.database,
			});
		}
		const user = assertRole(params.user);
		// A fresh cluster may not have the database yet (some apps create it
		// on first start): create it through the maintenance database first.
		const restore = String.raw`psql -X -A -t -U "$1" -d "$3" -c "select 1 from pg_database where datname = '$2'" | grep -q 1 || createdb -U "$1" -- "$2" || exit 1
exec psql -X -q -U "$1" -d "$2" ${params.strict ? "-v ON_ERROR_STOP=1 --single-transaction" : "-v ON_ERROR_STOP=0"}`;
		return {
			id: "postgres-database",
			file: "database.sql",
			strict: params.strict,
			dumpCommand: (container) =>
				`docker exec ${q(assertContainer(container))} pg_dump -U ${q(user)} -d ${q(params.database)} --clean --if-exists --quote-all-identifiers`,
			restoreCommand: (container) =>
				`docker exec -i ${q(assertContainer(container))} sh -c ${q(restore)} sh ${q(user)} ${q(params.database)} ${q(params.maintenance_database)}`,
		};
	},
});

/** MySQL and MariaDB: `mysqldump` / `mariadb-dump`, root password from the container env. */
function mysqlFamily(kind: "mysql" | "mariadb") {
	const dump = kind === "mysql" ? "mysqldump" : "mariadb-dump";
	const client = kind === "mysql" ? "mysql" : "mariadb";
	return define({
		params: z.object({
			user: z
				.string()
				.regex(/^[A-Za-z0-9_]{1,32}$/)
				.default("root"),
			/** Env var in the container holding the user's password. */
			password_env: envName.default(
				kind === "mysql" ? "MYSQL_ROOT_PASSWORD" : "MARIADB_ROOT_PASSWORD",
			),
			/** Databases to dump (empty: all, incl. users and grants). */
			databases: z.array(dbName).default([]),
			/** Fail on the first SQL error (default: continue and count them). */
			strict: z.boolean().default(false),
		}),
		build: (params) => {
			const scope = params.databases.length
				? `--databases ${params.databases.map(q).join(" ")}`
				: "--all-databases";
			// The password reaches the client through MYSQL_PWD inside the
			// container (`sh -c`), never through our command line. A full
			// dump ends with FLUSH PRIVILEGES: the restored users apply at once.
			const run = (command: string) =>
				`MYSQL_PWD="$(printenv ${params.password_env})" exec ${command}`;
			return {
				id: kind,
				file: `${kind}.sql`,
				dumpCommand: (container) =>
					`docker exec ${q(assertContainer(container))} sh -c ${q(
						run(
							`${dump} -u ${q(params.user)} --single-transaction --routines --triggers --events --add-drop-database${params.databases.length ? "" : " --flush-privileges"} ${scope}`,
						),
					)}`,
				strict: params.strict,
				restoreCommand: (container) =>
					`docker exec -i ${q(assertContainer(container))} sh -c ${q(
						run(
							`${client} -u ${q(params.user)}${params.strict ? "" : " --force"}`,
						),
					)}`,
			};
		},
	});
}

/** SQLite: online `.backup` to a temp file in the container, streamed out. */
const sqlite = define({
	params: z.object({
		/** Database file inside the container. */
		path: absoluteFile,
		/** sqlite3 binary in the container. */
		binary: z
			.string()
			.regex(/^[\w./-]+$/)
			.default("sqlite3"),
	}),
	build: (params) => {
		const tmp = `${params.path}.${resourceName("backup")}`;
		return {
			id: "sqlite",
			file: "database.sqlite",
			dumpCommand: (container) =>
				`docker exec ${q(assertContainer(container))} sh -c ${q(
					`${params.binary} ${q(params.path)} ${q(`.backup ${q(tmp)}`)} && cat ${q(tmp)}; status=$?; rm -f ${q(tmp)}; exit $status`,
				)}`,
			// The file is replaced as a whole, then the service restarts.
			restartAfterRestore: true,
			restoreCommand: (container) =>
				`docker exec -i ${q(assertContainer(container))} sh -c ${q(
					`cat > ${q(tmp)} && mv -f ${q(tmp)} ${q(params.path)}`,
				)}`,
		};
	},
});

const binary = z
	.string()
	.regex(/^[a-z][a-z0-9-]{0,40}$/)
	.default("valkey-cli");

/**
 * Redis protocol servers (Valkey, Redis 7+): a fresh RDB snapshot fetched
 * by the CLI over the replication protocol (`--rdb`: no blocking SAVE, no
 * race with the server's own saves) and streamed out. The restore installs
 * the snapshot both as `dump.rdb` and as the base of a new multi-part AOF
 * (`appendonlydir/` + manifest: with the AOF on, the server loads the AOF
 * and ignores dump.rdb), with saving and the AOF switched off for the
 * shutdown that follows (nothing overwrites them); the service restarts
 * and its command line turns them on again.
 * The password reaches the CLI through its env var inside the container.
 */
const redis = define({
	params: z.object({
		/** Env var in the container holding the `default` user's password. */
		password_env: envName.default("VALKEY_PASSWORD"),
		cli: binary,
		/** Server `dir` (where dump.rdb and the AOF directory live). */
		data_dir: absoluteFile.default("/data"),
	}),
	build: (params) => {
		const auth = `pw="$(printenv ${params.password_env})"; export VALKEYCLI_AUTH="$pw" REDISCLI_AUTH="$pw"; cli() { ${params.cli} --no-auth-warning "$@"; }`;
		const dir = q(params.data_dir);
		const dump = `${auth}; f=$(mktemp) || exit 1; cli --rdb "$f" >&2 && cat "$f"; s=$?; rm -f "$f"; exit $s`;
		const aof = `${dir}/appendonlydir`;
		const restore = [
			auth,
			`f=${dir}/${hiddenFileName("restore")}.rdb`,
			'cat > "$f" || exit 1',
			"cli CONFIG SET appendonly no >/dev/null || exit 1",
			`cli CONFIG SET save '' >/dev/null || exit 1`,
			`rm -rf ${aof}`,
			`mkdir ${aof} || exit 1`,
			`cp "$f" ${aof}/appendonly.aof.1.base.rdb || exit 1`,
			`: > ${aof}/appendonly.aof.1.incr.aof`,
			`printf 'file appendonly.aof.1.base.rdb seq 1 type b\nfile appendonly.aof.1.incr.aof seq 1 type i\n' > ${aof}/appendonly.aof.manifest || exit 1`,
			`mv -f "$f" ${dir}/dump.rdb`,
		].join("; ");
		return {
			id: "redis-rdb",
			file: "dump.rdb",
			restartAfterRestore: true,
			dumpCommand: (container) =>
				`docker exec ${q(assertContainer(container))} sh -c ${q(dump)}`,
			restoreCommand: (container) =>
				`docker exec -i ${q(assertContainer(container))} sh -c ${q(restore)}`,
		};
	},
});

/**
 * MongoDB: `mongodump --archive` of every database (users and roles
 * included) as the root user, restored with `mongorestore --drop`. The
 * password goes into a 0600 temp config file inside the container
 * (`--config`), never onto a command line.
 */
const mongodb = define({
	params: z.object({
		user_env: envName.default("MONGO_INITDB_ROOT_USERNAME"),
		password_env: envName.default("MONGO_INITDB_ROOT_PASSWORD"),
	}),
	build: (params) => {
		const login = (tool: string, flags: string) =>
			[
				"umask 077",
				"f=$(mktemp) || exit 1",
				// YAML double-quoted scalar: backslashes and quotes escaped.
				`printf 'password: "%s"\\n' "$(printenv ${params.password_env} | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')" > "$f"`,
				`${tool} --quiet --config "$f" --username "$(printenv ${params.user_env})" --authenticationDatabase admin ${flags}`,
				's=$?; rm -f "$f"; exit $s',
			].join("; ");
		return {
			id: "mongodb-archive",
			file: "mongodb.archive",
			dumpCommand: (container) =>
				`docker exec ${q(assertContainer(container))} sh -c ${q(login("mongodump", "--archive"))}`,
			restoreCommand: (container) =>
				`docker exec -i ${q(assertContainer(container))} sh -c ${q(login("mongorestore", "--archive --drop"))}`,
		};
	},
});

export const databaseStrategies: Record<string, DatabaseStrategyDefinition> = {
	postgres,
	mysql: mysqlFamily("mysql"),
	mariadb: mysqlFamily("mariadb"),
	sqlite,
	redis,
	mongodb,
};

const RESERVED_KEYS = new Set(["type", "service", "legacy_ids"]);

/** Build the strategy of a `[backup.database]` table (validated). */
export function buildDatabaseStrategy(
	table: { type: string } & Record<string, unknown>,
): DatabaseStrategy & { accepts: string[] } {
	const definition = databaseStrategies[table.type];
	if (!definition) {
		throw new TemplateError("BACKUP_DUMP_TYPE_UNKNOWN", {
			type: String(table.type),
		});
	}
	const params = Object.fromEntries(
		Object.entries(table).filter(([key]) => !RESERVED_KEYS.has(key)),
	);
	const parsed = definition.params.safeParse(params);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new TemplateError("BACKUP_DUMP_SETTINGS_INVALID", {
			field: `backup.database.${String(issue?.path[0] ?? "")}`,
			detail: issue?.message ?? "",
		});
	}
	const strategy = definition.build(parsed.data);
	const legacy = Array.isArray(table.legacy_ids)
		? (table.legacy_ids as string[])
		: [];
	return { ...strategy, accepts: [strategy.id, ...legacy] };
}
