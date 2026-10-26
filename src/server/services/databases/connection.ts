import type {
	DatabaseEngineId,
	DatabaseUrlPart,
} from "#/config/database-engines.ts";
import { DEFAULT_SSH_PORT } from "#/config/shared.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { serverEngines } from "./engines";
import type { DatabaseEndpoint, DatabaseLogin } from "./engines/common";

/**
 * Connection strings and client commands of a database (pure, tested):
 * the engine driver builds them (#/server/services/databases/engines.ts).
 * User, password and database name are percent-encoded in URLs (RFC 3986
 * userinfo/path), so any character is safe; commands never contain the
 * password (clients prompt for it, or read it from the env).
 */

export type { DatabaseEndpoint } from "./engines/common";

/**
 * `scheme://user:password@host:port/database`. `password: null` leaves it
 * out (shown masked until revealed).
 */
export function connectionUrl(
	engine: DatabaseEngineId,
	endpoint: DatabaseEndpoint,
	login: Omit<DatabaseLogin, "password"> & { password: string | null },
): string {
	return serverEngines[engine].connectionUrl(endpoint, login);
}

/** Shell command opening the engine's client (password prompted). */
export function clientCommand(
	engine: DatabaseEngineId,
	endpoint: DatabaseEndpoint,
	login: Omit<DatabaseLogin, "password">,
): string {
	return serverEngines[engine].clientCommand(endpoint, login);
}

/**
 * SSH tunnel to a database published on the server's 127.0.0.1:
 * `ssh -N -L <local>:127.0.0.1:<hostPort> user@server`.
 */
export function sshTunnelCommand(input: {
	sshUser: string;
	sshHost: string;
	sshPort: number;
	hostPort: number;
	localPort: number;
}): string {
	const port = input.sshPort === DEFAULT_SSH_PORT ? "" : ` -p ${input.sshPort}`;
	return `ssh -N -L ${input.localPort}:127.0.0.1:${input.hostPort}${port} ${q(`${input.sshUser}@${input.sshHost}`)}`;
}

/** Value of each URL part, as a linked app receives it. */
export function urlParts(
	endpoint: DatabaseEndpoint,
	login: DatabaseLogin,
): Record<DatabaseUrlPart, string | null> {
	return {
		host: endpoint.host,
		port: String(endpoint.port),
		user: login.user,
		password: login.password,
		database: login.database,
	};
}
