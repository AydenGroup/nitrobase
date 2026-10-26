import { databaseEngines } from "#/config/database-engines.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { clip } from "#/libs/format.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import {
	mysqlAdminCommand,
	mysqlCreateDatabaseSql,
	mysqlCreateUserSql,
	mysqlDropDatabaseSql,
	mysqlDropUserSql,
	mysqlGrantSql,
	mysqlListSql,
	protectedNames,
} from "../admin";
import {
	mariadbConsoleGrantsSql,
	mysqlConsoleCommand,
	mysqlConsoleScript,
	mysqlConsoleUserSql,
	parseMysqlBatch,
} from "../console";
import { checkConsoleSql, maskSqlLiterals } from "../sql";
import {
	baseService,
	CONSOLE_PASSWORD_ENV,
	CONSOLE_ROLES,
	consolePasswordVariable,
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

/** Accounts of the engine itself (never offered, never dropped). */
const SYSTEM_USER_PREFIX = "mysql.";
/** Account host of logins created from the UI (any host). */
const ANY_HOST = "%";

/**
 * MySQL and MariaDB (official images): same client protocol, SQL dialect
 * and users model. `kind` picks the image's env prefix, client binary and
 * the few behaviours that differ (statement timeout, partial revokes,
 * system table upgrades).
 */
export function mysqlFamilyEngine(kind: "mysql" | "mariadb"): ServerEngine {
	const prefix = kind === "mysql" ? "MYSQL" : "MARIADB";
	const rootPasswordEnv = `${prefix}_ROOT_PASSWORD`;
	const cli = databaseEngines[kind].cli;
	const adminCommand = (target: EngineTarget) =>
		mysqlAdminCommand({
			kind,
			container: target.container,
			rootPasswordEnv,
			nonce: target.nonce,
			limits: target.limits,
		});
	return {
		variables: {
			DB_USER: userVariable,
			DB_NAME: nameVariable,
			DB_PASSWORD: initialGenerated(text.password, true),
			DB_ROOT_PASSWORD: initialGenerated(text.rootPassword, true),
			CONSOLE_PASSWORD: consolePasswordVariable,
		},
		reservedUsers: [
			"root",
			"mysql",
			"healthcheck",
			"mariadb.sys",
			...CONSOLE_ROLES,
		],
		service: (image, tag) => ({
			...baseService(image, tag),
			environment: {
				[rootPasswordEnv]: v("DB_ROOT_PASSWORD"),
				[`${prefix}_USER`]: v("DB_USER"),
				[`${prefix}_PASSWORD`]: v("DB_PASSWORD"),
				[`${prefix}_DATABASE`]: v("DB_NAME"),
				[CONSOLE_PASSWORD_ENV]: v("CONSOLE_PASSWORD"),
				// MariaDB: upgrade the system tables after a version change.
				...(kind === "mariadb" ? { MARIADB_AUTO_UPGRADE: "1" } : {}),
			},
			volumes: [`${DATABASE_DATA_VOLUME}:/var/lib/mysql`],
			// TCP to 127.0.0.1: the init server runs with --skip-networking,
			// so the check passes only once the real server is up.
			healthcheck: healthcheck(
				kind === "mysql"
					? 'MYSQL_PWD="$$MYSQL_ROOT_PASSWORD" mysqladmin ping -h 127.0.0.1 -u root --silent'
					: "healthcheck.sh --connect --innodb_initialized",
				60,
			),
		}),
		backup: () => ({
			type: kind,
			service: DATABASE_SERVICE,
			legacy_ids: [],
			user: "root",
			password_env: rootPasswordEnv,
		}),
		login: userLogin,
		connectionUrl: (endpoint, login) => {
			const user = encodeUrlPart(login.user ?? "");
			const database = login.database
				? `/${encodeUrlPart(login.database)}`
				: "";
			return `mysql://${user}${urlPassword(login.password)}@${urlAuthority(endpoint)}${database}`;
		},
		clientCommand: (endpoint, login) =>
			`${cli} -h ${q(endpoint.host)} -P ${endpoint.port} -u ${q(login.user ?? "")} -p ${q(login.database ?? "")}`,
		size: {
			probe: (target) => ({
				command: adminCommand(target),
				input:
					"SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables;",
			}),
			parse: firstInteger,
		},
		consoleLogin: (target) => ({
			command: adminCommand(target),
			input: mysqlConsoleUserSql(target.values.CONSOLE_PASSWORD, kind),
		}),
		formatError: (output) => output.trim(),
		console: {
			prepare: (target, request) => {
				const { statements } = checkConsoleSql(request.text, "mysql", {
					readOnly: request.readOnly,
					maxBytes: request.maxBytes,
				});
				return {
					command: mysqlConsoleCommand({
						kind,
						container: target.container,
						database: request.database ?? target.values.DB_NAME,
						readOnly: request.readOnly,
						rootPasswordEnv,
						nonce: target.nonce,
						limits: target.limits,
					}),
					input: mysqlConsoleScript({
						kind,
						statements,
						readOnly: request.readOnly,
						nonce: target.nonce,
						timeoutMs: target.limits.timeoutMs,
					}),
					audited: statements.map((statement) =>
						clip(
							maskSqlLiterals(statement.text, "mysql"),
							TEXT_LIMITS.auditText,
						),
					),
				};
			},
			// MariaDB has no partial revokes: the read-only login is granted
			// database by database, refreshed before each read-only run (new
			// databases included, mysql.* never).
			beforeReadOnly: kind === "mariadb" ? mariadbConsoleGrantsSql : undefined,
			// No result set: mysql printed only the marker rows.
			outcome: (body, nonce, maxRows) => {
				const grid = parseMysqlBatch(body, nonce, maxRows);
				return grid ? { kind: "grid", ...grid } : { kind: "none", text: "" };
			},
		},
		admin: {
			dialect: "mysql",
			command: adminCommand,
			listSql: mysqlListSql,
			createDatabase: (name) => [{ sql: mysqlCreateDatabaseSql(name) }],
			createUser: (name, password) => [
				{ sql: mysqlCreateUserSql(name, password) },
			],
			grant: (database, user, host = ANY_HOST) => [
				{ sql: mysqlGrantSql(database, user, host) },
			],
			dropDatabase: (name) => [{ sql: mysqlDropDatabaseSql(name) }],
			dropUser: (name, host = ANY_HOST) => [
				{ sql: mysqlDropUserSql(name, host) },
			],
			isProtected: (what, name, main) => {
				const guard = protectedNames("mysql", main);
				return what === "database"
					? guard.databases.has(name)
					: guard.users.has(name) || name.startsWith(SYSTEM_USER_PREFIX);
			},
		},
	};
}
