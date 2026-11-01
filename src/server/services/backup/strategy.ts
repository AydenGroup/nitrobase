import { shellQuote as q } from "#/server/services/executor.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { internalError } from "#/utils/error.ts";

/**
 * Database dump strategy contributed by a provider plugin (server side).
 * Dumps stream over stdout of `docker exec` into the staging folder; the
 * restore reads the dump on stdin. Commands are built by the plugin from
 * validated values and quoted.
 */
export interface DatabaseStrategy {
	id: string;
	/** File name of the dump inside the archive's `db/`. */
	file: string;
	/** Prints the dump on stdout. */
	dumpCommand(container: string): string;
	/** Loads the dump from stdin into a freshly initialised database. */
	restoreCommand(container: string): string;
	/**
	 * The service must restart after the load (e.g. SQLite: the file was
	 * replaced under a running process).
	 */
	restartAfterRestore?: boolean;
	/**
	 * Any error fails the restore (the load is one transaction). Without it,
	 * errors from objects the image already created are tolerated and listed.
	 */
	strict?: boolean;
}

export function assertContainer(container: string): string {
	if (!/^[a-z0-9][a-z0-9_.-]*$/.test(container)) {
		throw internalError(`Invalid container ${container}`);
	}
	return container;
}

export function assertRole(role: string): string {
	if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
		throw new TemplateError("DATABASE_ROLE_INVALID", { role });
	}
	return role;
}

/**
 * Postgres cluster dump as a superuser, through `docker exec`, as one SQL
 * stream: roles (`pg_dumpall --globals-only --clean`), then for each
 * non-template database a `pg_dump --clean --if-exists` behind `\connect`
 * (created first when missing, then its owner and `ALTER DATABASE ... SET`
 * settings are applied: `CREATE DATABASE` alone would leave the superuser
 * as owner, and from Postgres 15 only the owner can create in `public`).
 * List settings (search_path, ...) are written unquoted, the rest as
 * literals. Databases are never dropped: dropping
 * one force-terminates extension background workers (pg_cron, pg_net) and
 * crash-restarts Postgres. The restore runs into a freshly initialised
 * cluster; `--clean` replaces what the image's init scripts created with
 * the backed-up objects, incl. migration tables.
 */
export function postgresStrategy(input: {
	id: string;
	user: string;
	database: string;
}): DatabaseStrategy {
	const user = assertRole(input.user);
	const database = assertRole(input.database);
	// printf, not echo: dash's echo interprets "\c" in "\connect".
	const dump = String.raw`pg_dumpall -U "$1" --globals-only --clean --if-exists --quote-all-identifiers || exit 1
for db in $(psql -X -A -t -U "$1" -d "$2" -c "select datname from pg_database where not datistemplate and datallowconn order by datname"); do
  printf '%s\n' '' "\\connect \"$2\"" "SELECT 'CREATE DATABASE \"$db\"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\\gexec" "\\connect \"$db\""
  psql -X -A -t -U "$1" -d "$2" -v db="$db" <<'SQL' || exit 1
SELECT format('ALTER DATABASE %I OWNER TO %I;', datname, pg_get_userbyid(datdba)) FROM pg_database WHERE datname = :'db';
SELECT format('ALTER DATABASE %I SET %I TO %s;', d.datname, split_part(c, '=', 1), CASE WHEN split_part(c, '=', 1) IN ('search_path', 'temp_tablespaces', 'session_preload_libraries', 'local_preload_libraries') THEN substr(c, strpos(c, '=') + 1) ELSE quote_literal(substr(c, strpos(c, '=') + 1)) END) FROM pg_database d JOIN pg_db_role_setting s ON s.setdatabase = d.oid AND s.setrole = 0, unnest(s.setconfig) AS c WHERE d.datname = :'db';
SQL
  pg_dump -U "$1" -d "$db" --clean --if-exists --quote-all-identifiers || exit 1
done`;
	return {
		id: input.id,
		file: "cluster.sql",
		dumpCommand: (container) =>
			`docker exec ${q(assertContainer(container))} sh -c ${q(dump)} sh ${q(user)} ${q(database)}`,
		// Some statements fail harmlessly (e.g. the connected role can't be
		// dropped, roles owning objects): errors don't stop the restore.
		restoreCommand: (container) =>
			`docker exec -i ${q(assertContainer(container))} psql -X -q -U ${q(user)} -d ${q(database)} -v ON_ERROR_STOP=0`,
	};
}
