import { majorOf } from "#/config/database-engines.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { clip } from "#/libs/format.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { formatPsqlError } from "#/server/services/supabase/sql.ts";
import {
	pgAdminCommand,
	pgCreateDatabaseSql,
	pgCreateUserSql,
	pgDropDatabaseSql,
	pgDropUserSql,
	pgGrantSql,
	pgListSql,
	protectedNames,
} from "../admin";
import {
	parseCsv,
	postgresConsoleRoleSql,
	psqlConsoleCommand,
} from "../console";
import { checkConsoleSql, maskSqlLiterals } from "../sql";
import {
	baseService,
	CONSOLE_ROLES,
	DATABASE_DATA_VOLUME,
	DATABASE_SERVICE,
	type EngineTarget,
	encodeUrlPart,
	firstInteger,
	healthcheck,
	initialGenerated,
	nameVariable,
	type ServerEngine,
	text,
	urlAuthority,
	urlPassword,
	userLogin,
	userVariable,
	v,
} from "./common";

/** Postgres 18+ keeps PGDATA in a versioned folder under /var/lib/postgresql. */
function postgresDataPath(tag: string): string {
	const major = Number.parseInt(
		majorOf("postgres", tag) ?? tag.split(".")[0],
		10,
	);
	return major >= 18 ? "/var/lib/postgresql" : "/var/lib/postgresql/data";
}

const adminCommand = (target: EngineTarget, database?: string) =>
	pgAdminCommand({
		container: target.container,
		superuser: target.values.DB_USER,
		database: database ?? target.values.DB_NAME,
		nonce: target.nonce,
		limits: target.limits,
	});

/** PostgreSQL (official image): psql, roles and databases management. */
export const postgresEngine: ServerEngine = {
	variables: {
		DB_USER: userVariable,
		DB_NAME: nameVariable,
		DB_PASSWORD: initialGenerated(text.password, true),
	},
	reservedUsers: [...CONSOLE_ROLES],
	service: (image, tag) => ({
		...baseService(image, tag),
		environment: {
			POSTGRES_USER: v("DB_USER"),
			POSTGRES_PASSWORD: v("DB_PASSWORD"),
			POSTGRES_DB: v("DB_NAME"),
		},
		volumes: [`${DATABASE_DATA_VOLUME}:${postgresDataPath(tag)}`],
		shm_size: "128mb",
		// TCP, not the socket: the init server only listens on the socket.
		healthcheck: healthcheck(
			'pg_isready -q -h 127.0.0.1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"',
		),
	}),
	backup: (values) => ({
		type: "postgres",
		service: DATABASE_SERVICE,
		legacy_ids: [],
		mode: "cluster",
		user: values.DB_USER ?? "app",
		database: values.DB_NAME ?? "app",
	}),
	login: userLogin,
	connectionUrl: (endpoint, login) => {
		const user = encodeUrlPart(login.user ?? "");
		const database = login.database ? `/${encodeUrlPart(login.database)}` : "";
		return `postgresql://${user}${urlPassword(login.password)}@${urlAuthority(endpoint)}${database}`;
	},
	clientCommand: (endpoint, login) =>
		`psql -h ${q(endpoint.host)} -p ${endpoint.port} -U ${q(login.user ?? "")} -d ${q(login.database ?? "")}`,
	size: {
		probe: (target) => ({
			command: adminCommand(target),
			input:
				"SELECT coalesce(sum(pg_database_size(oid)), 0)::bigint FROM pg_database;",
		}),
		parse: firstInteger,
	},
	consoleLogin: (target) => ({
		command: adminCommand(target),
		input: `${postgresConsoleRoleSql().join(";\n")};\n`,
	}),
	formatError: formatPsqlError,
	console: {
		prepare: (target, request) => {
			const { statements } = checkConsoleSql(request.text, "postgres", {
				readOnly: request.readOnly,
				maxBytes: request.maxBytes,
			});
			return {
				command: psqlConsoleCommand({
					container: target.container,
					database: request.database ?? target.values.DB_NAME,
					readOnly: request.readOnly,
					superuser: target.values.DB_USER,
					nonce: target.nonce,
					limits: target.limits,
				}),
				input: request.text,
				audited: statements.map((statement) =>
					clip(
						maskSqlLiterals(statement.text, "postgres"),
						TEXT_LIMITS.auditText,
					),
				),
			};
		},
		// psql prints nothing for a statement without a result set.
		outcome: (body, _nonce, maxRows) =>
			body.trim()
				? { kind: "grid", ...parseCsv(body, maxRows) }
				: { kind: "none", text: "" },
	},
	admin: {
		dialect: "postgres",
		command: adminCommand,
		listSql: pgListSql,
		createDatabase: (name, owner) => [
			{ sql: pgCreateDatabaseSql(name, owner) },
		],
		createUser: (name, password) => [{ sql: pgCreateUserSql(name, password) }],
		grant: (database, user) => {
			const grant = pgGrantSql(database, user);
			return [{ sql: grant.cluster }, { sql: grant.inDatabase, database }];
		},
		dropDatabase: (name) => [{ sql: pgDropDatabaseSql(name) }],
		dropUser: (name) => [{ sql: pgDropUserSql(name) }],
		isProtected: (kind, name, main) => {
			const guard = protectedNames("postgres", main);
			return (kind === "database" ? guard.databases : guard.users).has(name);
		},
	},
};
