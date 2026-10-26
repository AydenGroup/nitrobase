import { databaseEngines } from "#/config/database-engines.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import {
	checkRedisCommand,
	maskRedisCommand,
	redisConsoleCommand,
} from "../kv-console";
import {
	baseService,
	DATABASE_DATA_VOLUME,
	DATABASE_SERVICE,
	type EngineTarget,
	generated,
	healthcheck,
	matchedInteger,
	type ServerEngine,
	text,
	urlAuthority,
	urlPassword,
	v,
} from "./common";

const PASSWORD_ENV = "VALKEY_PASSWORD";
const DATA_DIR = "/data";
const cli = databaseEngines.valkey.cli;

/** A reply that is an error (short: a value can contain these words too). */
const ERROR_REPLY = /^\(error\)|^ERR |^WRONGTYPE|^NOAUTH/m;

const command = (target: EngineTarget, args: string[]) =>
	redisConsoleCommand({
		container: target.container,
		cli,
		passwordEnv: PASSWORD_ENV,
		args,
		nonce: target.nonce,
		limits: target.limits,
	});

/** Valkey (Redis-compatible): one password, numbered databases. */
export const valkeyEngine: ServerEngine = {
	variables: { DB_PASSWORD: generated(text.password, true) },
	reservedUsers: [],
	service: (image, tag) => ({
		...baseService(image, tag),
		// The image's user (the entrypoint only drops root for its own
		// command line); the data volume belongs to it.
		user: "valkey",
		environment: { [PASSWORD_ENV]: v("DB_PASSWORD") },
		// The password goes in as config on stdin, not on the command
		// line. RDB snapshots plus the append-only file.
		command: [
			"sh",
			"-c",
			`printf 'requirepass "%s"\\n' "$$VALKEY_PASSWORD" | exec valkey-server - --dir ${DATA_DIR} --appendonly yes --appendfsync everysec --save "3600 1 300 100 60 10000"`,
		],
		volumes: [`${DATABASE_DATA_VOLUME}:${DATA_DIR}`],
		healthcheck: healthcheck(
			`VALKEYCLI_AUTH="$$VALKEY_PASSWORD" REDISCLI_AUTH="$$VALKEY_PASSWORD" ${cli} --no-auth-warning ping | grep -q PONG`,
			10,
		),
	}),
	backup: () => ({
		type: "redis",
		service: DATABASE_SERVICE,
		legacy_ids: [],
		password_env: PASSWORD_ENV,
		cli,
		data_dir: DATA_DIR,
	}),
	login: (values) => ({
		user: null,
		password: values.DB_PASSWORD ?? "",
		database: null,
	}),
	// The `default` user (ACL-less password auth), database 0.
	connectionUrl: (endpoint, login) =>
		`redis://default${urlPassword(login.password)}@${urlAuthority(endpoint)}/0`,
	clientCommand: (endpoint) =>
		`${cli} -h ${q(endpoint.host)} -p ${endpoint.port} --askpass`,
	size: {
		probe: (target) => ({
			command: command(target, ["INFO", "memory"]),
			input: "",
		}),
		parse: (stdout) => matchedInteger(stdout, /used_memory:(\d+)/),
	},
	consoleLogin: () => null,
	formatError: (output) => output.trim(),
	console: {
		prepare: (target, request) => {
			const args = checkRedisCommand(request.text, request);
			return {
				command: command(target, args),
				input: "",
				audited: [maskRedisCommand(args)],
			};
		},
		outcome: (body) => {
			const reply = body.trim();
			return ERROR_REPLY.test(reply) && reply.split("\n").length <= 2
				? { kind: "error", error: reply }
				: { kind: "text", text: reply };
		},
	},
};
