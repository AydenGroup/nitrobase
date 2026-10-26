import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { clip } from "#/libs/format.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { internalError } from "#/utils/error.ts";
import {
	assertConsoleDatabase,
	assertContainer,
	assertNonce,
	type ConsoleLimits,
	capped,
} from "./console";
import { CONSOLE_PASSWORD_ENV, CONSOLE_ROLE } from "./engines/common";
import { ConsoleRefusal } from "./sql";

/**
 * Command runners of Valkey (Redis protocol) and MongoDB consoles (pure,
 * tested): one command per run. Read-only mode allows an explicit list of
 * reading commands; write mode allows everything except server
 * administration (shutdown, replication, config, modules…).
 */

// ---------------------------------------------------------------------------
// Valkey / Redis

/** Reading commands (read-only mode); `KEYS` is left out: use SCAN. */
const REDIS_READ_COMMANDS = new Set([
	"PING",
	"ECHO",
	"DBSIZE",
	"INFO",
	"TIME",
	"LASTSAVE",
	"EXISTS",
	"TYPE",
	"TTL",
	"PTTL",
	"EXPIRETIME",
	"PEXPIRETIME",
	"STRLEN",
	"GET",
	"MGET",
	"GETRANGE",
	"SUBSTR",
	"LCS",
	"HGET",
	"HMGET",
	"HGETALL",
	"HKEYS",
	"HVALS",
	"HLEN",
	"HEXISTS",
	"HSTRLEN",
	"HSCAN",
	"HRANDFIELD",
	"LRANGE",
	"LLEN",
	"LINDEX",
	"LPOS",
	"SMEMBERS",
	"SCARD",
	"SISMEMBER",
	"SMISMEMBER",
	"SRANDMEMBER",
	"SSCAN",
	"SINTER",
	"SUNION",
	"SDIFF",
	"SINTERCARD",
	"ZRANGE",
	"ZRANGEBYSCORE",
	"ZREVRANGE",
	"ZREVRANGEBYSCORE",
	"ZRANGEBYLEX",
	"ZCARD",
	"ZCOUNT",
	"ZLEXCOUNT",
	"ZSCORE",
	"ZMSCORE",
	"ZRANK",
	"ZREVRANK",
	"ZSCAN",
	"ZRANDMEMBER",
	"XLEN",
	"XRANGE",
	"XREVRANGE",
	"XINFO",
	"XPENDING",
	"PFCOUNT",
	"GETBIT",
	"BITCOUNT",
	"BITPOS",
	"GEOPOS",
	"GEODIST",
	"GEOHASH",
	"GEOSEARCH",
	"SCAN",
	"RANDOMKEY",
	"OBJECT",
	"MEMORY",
	"SLOWLOG",
	"COMMAND",
]);

/** Subcommands allowed for the read commands that also write/administer. */
const REDIS_READ_SUBCOMMANDS: Record<string, Set<string>> = {
	OBJECT: new Set(["ENCODING", "FREQ", "IDLETIME", "REFCOUNT", "HELP"]),
	MEMORY: new Set(["USAGE", "STATS", "DOCTOR", "HELP"]),
	SLOWLOG: new Set(["GET", "LEN", "HELP"]),
	XINFO: new Set(["STREAM", "GROUPS", "CONSUMERS", "HELP"]),
	COMMAND: new Set(["COUNT", "INFO", "DOCS", "LIST", "GETKEYS", "HELP"]),
};

/**
 * Never allowed, even in write mode: server administration, replication,
 * blocking/streaming commands that would hang the one-shot runner, and
 * scripting (arbitrary server-side code).
 */
const REDIS_DENIED_COMMANDS = new Set([
	"SHUTDOWN",
	"CONFIG",
	"DEBUG",
	"MODULE",
	"ACL",
	"REPLICAOF",
	"SLAVEOF",
	"SYNC",
	"PSYNC",
	"REPLCONF",
	"FAILOVER",
	"CLUSTER",
	"MIGRATE",
	"MONITOR",
	"SUBSCRIBE",
	"PSUBSCRIBE",
	"SSUBSCRIBE",
	"BLPOP",
	"BRPOP",
	"BLMOVE",
	"BRPOPLPUSH",
	"BLMPOP",
	"BZPOPMIN",
	"BZPOPMAX",
	"BZMPOP",
	"WAIT",
	"WAITAOF",
	"EVAL",
	"EVALSHA",
	"EVAL_RO",
	"EVALSHA_RO",
	"SCRIPT",
	"FUNCTION",
	"FCALL",
	"FCALL_RO",
	"SAVE",
	"BGSAVE",
	"BGREWRITEAOF",
	"CLIENT",
	"HELLO",
	"AUTH",
	"RESET",
	"MULTI",
	"EXEC",
	"WATCH",
	"LATENCY",
	"LOLWUT",
	// O(N) over every key: use SCAN.
	"KEYS",
]);

/**
 * Split a command line into arguments: whitespace separates, `"…"`
 * (with `\"`, `\\`, `\n`, `\t`, `\xHH` escapes) and `'…'` quote.
 */
export function tokenizeRedisCommand(line: string): string[] {
	const args: string[] = [];
	let i = 0;
	const n = line.length;
	while (i < n) {
		while (i < n && /\s/.test(line[i])) i++;
		if (i >= n) break;
		let arg = "";
		let any = false;
		while (i < n && !/\s/.test(line[i])) {
			const c = line[i];
			if (c === '"') {
				any = true;
				i++;
				for (;;) {
					if (i >= n) throw new TemplateError("CONSOLE_UNTERMINATED_QUOTE");
					const d = line[i];
					if (d === "\\") {
						const e = line[i + 1];
						if (
							e === "x" &&
							/^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))
						) {
							arg += String.fromCharCode(
								Number.parseInt(line.slice(i + 2, i + 4), 16),
							);
							i += 4;
							continue;
						}
						arg +=
							e === "n"
								? "\n"
								: e === "t"
									? "\t"
									: e === "r"
										? "\r"
										: (e ?? "");
						i += 2;
						continue;
					}
					if (d === '"') {
						i++;
						break;
					}
					arg += d;
					i++;
				}
			} else if (c === "'") {
				any = true;
				const end = line.indexOf("'", i + 1);
				if (end === -1) throw new TemplateError("CONSOLE_UNTERMINATED_QUOTE");
				arg += line.slice(i + 1, end);
				i = end + 1;
			} else {
				any = true;
				arg += c;
				i++;
			}
		}
		if (any) args.push(arg);
	}
	return args;
}

/** Validate a command for the mode; returns the arguments. */
export function checkRedisCommand(
	line: string,
	options: { readOnly: boolean; maxBytes: number; scanMaxCount: number },
): string[] {
	if (line.includes("\0")) throw new TemplateError("CONSOLE_NUL");
	if (Buffer.byteLength(line, "utf8") > options.maxBytes) {
		throw new TemplateError("CONSOLE_TOO_LARGE", {
			max: { $bytes: options.maxBytes },
		});
	}
	if (/[\r\n]/.test(line.trim())) {
		throw new TemplateError("CONSOLE_ONE_COMMAND");
	}
	const args = tokenizeRedisCommand(line);
	const command = args[0]?.toUpperCase();
	if (!command) throw new TemplateError("CONSOLE_EMPTY");
	// valkey-cli reads a leading "-…" as one of its own options.
	if (command.startsWith("-")) {
		throw new ConsoleRefusal("DATABASE_COMMAND_DENIED", command);
	}
	if (REDIS_DENIED_COMMANDS.has(command)) {
		throw new ConsoleRefusal("DATABASE_COMMAND_DENIED", command);
	}
	// Bounded iteration: every SCAN COUNT above the cap is refused (Valkey
	// honours the last one, so each occurrence is checked). Options are read
	// as pairs after the key/cursor, so `MATCH COUNT` stays a pattern.
	if (/^[HSZ]?SCAN$/.test(command)) {
		let at = command === "SCAN" ? 2 : 3;
		while (at < args.length) {
			const option = args[at].toUpperCase();
			if (option === "COUNT") {
				const count = Number(args[at + 1]);
				if (
					!Number.isInteger(count) ||
					count < 1 ||
					count > options.scanMaxCount
				) {
					throw new ConsoleRefusal(
						"DATABASE_COMMAND_DENIED",
						`${command} COUNT ${args[at + 1] ?? ""}`,
					);
				}
			}
			at +=
				option === "COUNT" || option === "MATCH" || option === "TYPE" ? 2 : 1;
		}
	}
	if (options.readOnly) {
		if (!REDIS_READ_COMMANDS.has(command)) {
			throw new ConsoleRefusal("DATABASE_COMMAND_READ_ONLY", command);
		}
		const sub = REDIS_READ_SUBCOMMANDS[command];
		if (sub && !sub.has(args[1]?.toUpperCase() ?? "")) {
			throw new ConsoleRefusal(
				"DATABASE_COMMAND_READ_ONLY",
				`${command} ${args[1] ?? ""}`.trim(),
			);
		}
	}
	return args;
}

/**
 * valkey-cli running one command (arguments as positional parameters, the
 * password from the container env).
 */
export function redisConsoleCommand(input: {
	container: string;
	cli: string;
	passwordEnv: string;
	args: string[];
	nonce: string;
	limits: ConsoleLimits;
}): string {
	if (!/^[a-z][a-z0-9-]{0,40}$/.test(input.cli))
		throw internalError("Invalid cli");
	if (!/^[A-Z_][A-Z0-9_]*$/.test(input.passwordEnv)) {
		throw internalError("Invalid password variable");
	}
	const timeout = Math.max(1, Math.ceil(input.limits.timeoutMs / 1000));
	const run = `pw="$(printenv ${input.passwordEnv})"; VALKEYCLI_AUTH="$pw" REDISCLI_AUTH="$pw" timeout ${timeout} ${input.cli} --no-auth-warning "$@"`;
	const script = capped(run, assertNonce(input.nonce), input.limits);
	return [
		"docker exec -i",
		q(assertContainer(input.container)),
		"sh -c",
		q(script),
		"sh",
		...input.args.map(q),
	].join(" ");
}

// ---------------------------------------------------------------------------
// MongoDB

/** Commands allowed in read-only mode (first key of the command document). */
const MONGO_READ_COMMANDS = new Set([
	"find",
	"aggregate",
	"count",
	"distinct",
	"listCollections",
	"listDatabases",
	"listIndexes",
	"dbStats",
	"collStats",
	"dataSize",
	"serverStatus",
	"hostInfo",
	"buildInfo",
	"ping",
	"hello",
	"isMaster",
	"connectionStatus",
	"explain",
]);

/** Never allowed: server administration. */
const MONGO_DENIED_COMMANDS = new Set([
	"shutdown",
	"fsync",
	"fsyncUnlock",
	"setParameter",
	"setFeatureCompatibilityVersion",
	"replSetInitiate",
	"replSetReconfig",
	"replSetStepDown",
	"replSetFreeze",
	"logRotate",
	"compact",
	"setDefaultRWConcern",
	"createUser",
	"updateUser",
	"dropUser",
	"dropAllUsersFromDatabase",
	"grantRolesToUser",
	"revokeRolesFromUser",
	"createRole",
	"updateRole",
	"dropRole",
	"eval",
]);

/** Commands that get `maxTimeMS` (the console's timeout) unless set. */
const MONGO_TIMED_COMMANDS = ["find", "aggregate", "count", "distinct"];

/** Pipeline stages that write (refused in read-only mode). */
const MONGO_WRITE_STAGES = new Set(["$out", "$merge"]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function hasWriteStage(value: Json): boolean {
	if (Array.isArray(value)) return value.some(hasWriteStage);
	if (value && typeof value === "object") {
		return Object.entries(value).some(
			([key, inner]) => MONGO_WRITE_STAGES.has(key) || hasWriteStage(inner),
		);
	}
	return false;
}

/**
 * Validate a command document (JSON / Extended JSON) for the mode.
 * Returns the command name.
 */
export function checkMongoCommand(
	text: string,
	options: { readOnly: boolean; maxBytes: number },
): string {
	if (Buffer.byteLength(text, "utf8") > options.maxBytes) {
		throw new TemplateError("CONSOLE_TOO_LARGE", {
			max: { $bytes: options.maxBytes },
		});
	}
	let parsed: Json;
	try {
		parsed = JSON.parse(text) as Json;
	} catch {
		throw new TemplateError("CONSOLE_JSON_REQUIRED", {
			example: '{"find": "users", "filter": {}, "limit": 20}',
		});
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new TemplateError("CONSOLE_JSON_OBJECT");
	}
	const [name] = Object.keys(parsed);
	if (!name) throw new TemplateError("CONSOLE_EMPTY");
	if (MONGO_DENIED_COMMANDS.has(name)) {
		throw new ConsoleRefusal("DATABASE_COMMAND_DENIED", name);
	}
	if (options.readOnly) {
		if (!MONGO_READ_COMMANDS.has(name)) {
			throw new ConsoleRefusal("DATABASE_COMMAND_READ_ONLY", name);
		}
		if (name === "explain") {
			const inner = parsed.explain;
			const innerName =
				inner && typeof inner === "object" && !Array.isArray(inner)
					? Object.keys(inner)[0]
					: undefined;
			if (!innerName || !MONGO_READ_COMMANDS.has(innerName)) {
				throw new ConsoleRefusal(
					"DATABASE_COMMAND_READ_ONLY",
					`explain ${innerName ?? ""}`.trim(),
				);
			}
		}
		if (hasWriteStage(parsed)) {
			throw new ConsoleRefusal("DATABASE_COMMAND_READ_ONLY", "$out/$merge");
		}
	}
	return name;
}

/**
 * mongosh script running one command: logs in from the container env
 * (console user or root), runs the command document, prints Extended
 * JSON. The command and database are embedded as JSON string literals.
 */
export function mongoConsoleScript(input: {
	command: string;
	database: string;
	readOnly: boolean;
	/** Server-side time limit for reading commands (`maxTimeMS` when unset). */
	maxTimeMs: number;
}): string {
	const maxTime = Math.max(1, Math.floor(input.maxTimeMs));
	const user = input.readOnly
		? JSON.stringify(CONSOLE_ROLE)
		: "process.env.MONGO_INITDB_ROOT_USERNAME";
	const password = input.readOnly
		? `process.env.${CONSOLE_PASSWORD_ENV}`
		: "process.env.MONGO_INITDB_ROOT_PASSWORD";
	return [
		`db.getSiblingDB("admin").auth(${user}, ${password});`,
		"let result;",
		"try {",
		`  const command = EJSON.parse(${JSON.stringify(input.command)});`,
		// maxTimeMS is clamped to the console timeout (0 or a non-number = unset).
		`  if (${JSON.stringify(MONGO_TIMED_COMMANDS)}.includes(Object.keys(command)[0])) { const asked = Number(command.maxTimeMS); command.maxTimeMS = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), ${maxTime}) : ${maxTime}; }`,
		`  result = db.getSiblingDB(${JSON.stringify(assertConsoleDatabase(input.database))}).runCommand(command);`,
		"} catch (error) {",
		"  result = { ok: 0, errmsg: String(error && error.message ? error.message : error) };",
		"}",
		"print(EJSON.stringify(result, null, 2, { relaxed: true }));",
	].join("\n");
}

/** mongosh reading the script on stdin (`--eval "$(cat)"`, no rc file). */
export function mongoConsoleCommand(input: {
	container: string;
	nonce: string;
	limits: ConsoleLimits;
}): string {
	const timeout = Math.max(1, Math.ceil(input.limits.timeoutMs / 1000));
	const run = `script=$(cat); timeout ${timeout} mongosh --quiet --norc --host 127.0.0.1 --eval "$script"`;
	return [
		"docker exec -i",
		q(assertContainer(input.container)),
		"sh -c",
		q(capped(run, assertNonce(input.nonce), input.limits)),
	].join(" ");
}

// ---------------------------------------------------------------------------
// Audit text (values hidden)

/** Mongo command for the audit log: keys kept, every string value hidden. */
export function maskMongoCommand(text: string): string {
	const mask = (value: Json): Json => {
		if (typeof value === "string") return "…";
		if (Array.isArray(value)) return value.map(mask);
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, inner]) => [key, mask(inner)]),
			);
		}
		return value;
	};
	try {
		return clip(
			JSON.stringify(mask(JSON.parse(text) as Json)),
			TEXT_LIMITS.auditText,
		);
	} catch {
		return "(unreadable command)";
	}
}

/** Valkey command for the audit log: the command and its key, values hidden. */
export function maskRedisCommand(args: string[]): string {
	const [command = "", key, ...rest] = args;
	return clip(
		[command, ...(key === undefined ? [] : [key]), ...rest.map(() => "…")].join(
			" ",
		),
		TEXT_LIMITS.auditText,
	);
}
