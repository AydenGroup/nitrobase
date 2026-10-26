import { shellQuote as q } from "#/server/services/executor.ts";
import { mongoConsoleUserScript } from "../console";
import {
	checkMongoCommand,
	maskMongoCommand,
	mongoConsoleCommand,
	mongoConsoleScript,
} from "../kv-console";
import {
	baseService,
	CONSOLE_PASSWORD_ENV,
	CONSOLE_ROLES,
	consolePasswordVariable,
	DATABASE_DATA_VOLUME,
	DATABASE_SERVICE,
	type DatabaseEndpoint,
	type DatabaseLogin,
	type EngineTarget,
	encodeUrlPart,
	healthcheck,
	initialGenerated,
	matchedInteger,
	nameVariable,
	type ServerEngine,
	text,
	urlAuthority,
	urlPassword,
	userLogin,
	userVariable,
	v,
} from "./common";

/** Database the root user lives in (and commands run in by default). */
const AUTH_DATABASE = "admin";
const CONFIG_VOLUME = "configdb";

const command = (target: EngineTarget) =>
	mongoConsoleCommand({
		container: target.container,
		nonce: target.nonce,
		limits: target.limits,
	});

const connectionUrl = (
	endpoint: DatabaseEndpoint,
	login: Omit<DatabaseLogin, "password"> & { password: string | null },
) => {
	const user = encodeUrlPart(login.user ?? "");
	const database = encodeUrlPart(login.database ?? AUTH_DATABASE);
	return `mongodb://${user}${urlPassword(login.password)}@${urlAuthority(endpoint)}/${database}?authSource=${AUTH_DATABASE}`;
};

/** MongoDB Community Server (official image): one command document per run. */
export const mongodbEngine: ServerEngine = {
	variables: {
		DB_USER: userVariable,
		DB_NAME: nameVariable,
		DB_PASSWORD: initialGenerated(text.password, true),
		CONSOLE_PASSWORD: consolePasswordVariable,
	},
	reservedUsers: [...CONSOLE_ROLES],
	service: (image, tag) => ({
		...baseService(image, tag),
		environment: {
			MONGO_INITDB_ROOT_USERNAME: v("DB_USER"),
			MONGO_INITDB_ROOT_PASSWORD: v("DB_PASSWORD"),
			MONGO_INITDB_DATABASE: v("DB_NAME"),
			[CONSOLE_PASSWORD_ENV]: v("CONSOLE_PASSWORD"),
		},
		volumes: [
			`${DATABASE_DATA_VOLUME}:/data/db`,
			`${CONFIG_VOLUME}:/data/configdb`,
		],
		// The container's hostname, not localhost: the init server only
		// binds 127.0.0.1, so the check passes once the real one is up.
		healthcheck: healthcheck(
			`mongosh --quiet --norc --host "$$(hostname)" --eval "db.adminCommand('ping').ok" | grep -q 1`,
			30,
		),
	}),
	extraVolumes: [CONFIG_VOLUME],
	backup: () => ({
		type: "mongodb",
		service: DATABASE_SERVICE,
		legacy_ids: [],
	}),
	login: userLogin,
	connectionUrl,
	clientCommand: (endpoint, login) =>
		`mongosh ${q(connectionUrl(endpoint, { ...login, password: null }))} --password`,
	size: {
		probe: (target) => ({
			command: command(target),
			input: mongoConsoleScript({
				command: JSON.stringify({ listDatabases: 1 }),
				database: AUTH_DATABASE,
				readOnly: false,
				maxTimeMs: target.limits.timeoutMs,
			}),
		}),
		parse: (stdout) => matchedInteger(stdout, /"totalSize":\s*(\d+)/),
	},
	consoleLogin: (target) => ({
		command: command(target),
		input: mongoConsoleUserScript(),
		verify: (body) => body.includes("ok"),
	}),
	formatError: (output) => output.trim(),
	console: {
		prepare: (target, request) => {
			checkMongoCommand(request.text, request);
			return {
				command: command(target),
				input: mongoConsoleScript({
					command: request.text,
					// Same default as the connection: the app's main database.
					database:
						request.database ??
						userLogin(target.values).database ??
						AUTH_DATABASE,
					readOnly: request.readOnly,
					maxTimeMs: target.limits.timeoutMs,
				}),
				audited: [maskMongoCommand(request.text)],
			};
		},
		// A failed command still exits 0: its reply says `ok: 0`.
		outcome: (body) => {
			const reply = body.trim();
			if (/"ok":\s*0\b/.test(reply) && /"errmsg"/.test(reply)) {
				const match = /"errmsg":\s*"((?:[^"\\]|\\.)*)"/.exec(reply);
				return {
					kind: "error",
					error: match ? JSON.parse(`"${match[1]}"`) : reply,
				};
			}
			return { kind: "text", text: reply };
		},
	},
};
