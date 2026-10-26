import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const {
	checkMongoCommand,
	checkRedisCommand,
	mongoConsoleCommand,
	maskMongoCommand,
	maskRedisCommand,
	mongoConsoleScript,
	redisConsoleCommand,
	tokenizeRedisCommand,
} = await import("./kv-console");

const ro = { readOnly: true, maxBytes: 4096, scanMaxCount: 1000 };
const rw = { readOnly: false, maxBytes: 4096, scanMaxCount: 1000 };
const nonce = "0123456789abcdef0123456789abcdef";

describe("redis command runner", () => {
	it("tokenizes quoted arguments", () => {
		expect(tokenizeRedisCommand(`SET "a key" 'it''s' "x\\"y\\n\\x41"`)).toEqual(
			["SET", "a key", "its", 'x"y\nA'],
		);
		expect(tokenizeRedisCommand('GET ""')).toEqual(["GET", ""]);
		expect(() => tokenizeRedisCommand('GET "x')).toThrow();
	});

	it("allows only reading commands in read-only mode", () => {
		expect(checkRedisCommand("get user:1", ro)).toEqual(["get", "user:1"]);
		expect(checkRedisCommand("SCAN 0 MATCH user:* COUNT 100", ro)[0]).toBe(
			"SCAN",
		);
		expect(checkRedisCommand("MEMORY USAGE k", ro)).toHaveLength(3);
		for (const line of [
			"SET k v",
			"DEL k",
			"FLUSHALL",
			"KEYS *",
			"OBJECT FREQ2 k",
			"MEMORY PURGE",
			"XADD s * a 1",
		]) {
			expect(() => checkRedisCommand(line, ro), line).toThrow();
		}
	});

	it("refuses administration and blocking commands in every mode", () => {
		expect(checkRedisCommand("SET k v", rw)).toEqual(["SET", "k", "v"]);
		for (const line of [
			"CONFIG SET dir /",
			"SHUTDOWN",
			"eval 'x' 0",
			"MONITOR",
			"BLPOP q 0",
			"REPLICAOF a 1",
			"ACL LIST",
			"DEBUG SLEEP 1",
			"MODULE LOAD x",
		]) {
			expect(() => checkRedisCommand(line, rw), line).toThrow();
		}
		expect(() => checkRedisCommand("GET a\nDEL a", rw)).toThrow(/one command/);
		expect(() => checkRedisCommand("   ", rw)).toThrow(/empty/);
	});

	it("passes arguments as positional parameters, password from the env", () => {
		const command = redisConsoleCommand({
			container: "database-0123abcd-db",
			cli: "valkey-cli",
			passwordEnv: "VALKEY_PASSWORD",
			args: ["GET", "it's; rm -rf /"],
			nonce,
			limits: { timeoutMs: 5000, maxBytes: 4096, maxErrorBytes: 4096 },
		});
		expect(command).toContain(`'GET' 'it'\\''s; rm -rf /'`);
		expect(command).toContain("printenv VALKEY_PASSWORD");
		expect(command).toContain("timeout 5 valkey-cli --no-auth-warning");
	});
});

describe("mongo command runner", () => {
	it("allows reading commands in read-only mode", () => {
		expect(checkMongoCommand('{"find": "users", "filter": {"a": 1}}', ro)).toBe(
			"find",
		);
		expect(checkMongoCommand('{"listCollections": 1}', ro)).toBe(
			"listCollections",
		);
		expect(
			checkMongoCommand(
				'{"explain": {"find": "users"}, "verbosity": "queryPlanner"}',
				ro,
			),
		).toBe("explain");
	});

	it("refuses writes, $out/$merge and admin commands", () => {
		for (const text of [
			'{"insert": "users", "documents": [{}]}',
			'{"delete": "users", "deletes": []}',
			'{"drop": "users"}',
			'{"aggregate": "users", "pipeline": [{"$out": "x"}], "cursor": {}}',
			'{"aggregate": "users", "pipeline": [{"$lookup": {"pipeline": [{"$merge": "x"}]}}], "cursor": {}}',
			'{"explain": {"delete": "users", "deletes": []}}',
		]) {
			expect(() => checkMongoCommand(text, ro), text).toThrow();
		}
		expect(
			checkMongoCommand('{"insert": "users", "documents": [{}]}', rw),
		).toBe("insert");
		for (const text of [
			'{"shutdown": 1}',
			'{"createUser": "x"}',
			'{"setParameter": 1}',
		]) {
			expect(() => checkMongoCommand(text, rw), text).toThrow();
		}
		expect(() => checkMongoCommand("db.users.find()", rw)).toThrow(/JSON/);
		expect(() => checkMongoCommand("[1]", rw)).toThrow(/object/);
	});

	it("embeds the command and database as JSON string literals", () => {
		const script = mongoConsoleScript({
			command: '{"find": "u\\"); quit(); ("}',
			database: "app",
			readOnly: true,
			maxTimeMs: 15000,
		});
		expect(script).toContain(
			'auth("nitrobase_console", process.env.NITROBASE_CONSOLE_PASSWORD)',
		);
		expect(script).toContain(
			'EJSON.parse("{\\"find\\": \\"u\\\\\\"); quit(); (\\"}")',
		);
		expect(script).toContain('getSiblingDB("app")');
		const write = mongoConsoleScript({
			command: "{}",
			database: "app",
			readOnly: false,
			maxTimeMs: 15000,
		});
		expect(write).toContain("process.env.MONGO_INITDB_ROOT_PASSWORD");
		expect(() =>
			mongoConsoleScript({
				command: "{}",
				database: "a b",
				readOnly: true,
				maxTimeMs: 15000,
			}),
		).toThrow();
	});

	it("reads the script on stdin", () => {
		const command = mongoConsoleCommand({
			container: "database-0123abcd-db",
			nonce,
			limits: { timeoutMs: 15000, maxBytes: 4096, maxErrorBytes: 4096 },
		});
		expect(command).toContain(
			'script=$(cat); timeout 15 mongosh --quiet --norc --host 127.0.0.1 --eval "$script"',
		);
	});
});

describe("console hardening", () => {
	it("refuses option-like first tokens, KEYS in every mode and large SCAN counts", () => {
		for (const line of [
			"--rdb /tmp/x",
			"-h evil GET a",
			"KEYS *",
			"keys user:*",
		]) {
			expect(() => checkRedisCommand(line, rw), line).toThrow();
		}
		expect(() => checkRedisCommand("SCAN 0 COUNT 5000", ro)).toThrow(/COUNT/);
		expect(() => checkRedisCommand("HSCAN h 0 COUNT x", ro)).toThrow(/COUNT/);
		expect(checkRedisCommand("SCAN 0 COUNT 1000", ro)).toHaveLength(4);
		// Every COUNT is checked (the server honours the last one).
		expect(() => checkRedisCommand("SCAN 0 COUNT 10 COUNT 100000", ro)).toThrow(
			/COUNT/,
		);
		expect(() =>
			checkRedisCommand("ZSCAN z 0 MATCH a* COUNT 5 COUNT 0", ro),
		).toThrow(/COUNT/);
		// A pattern or key named "count" is not an option.
		expect(checkRedisCommand("SCAN 0 MATCH COUNT COUNT 10", ro)).toHaveLength(
			6,
		);
		expect(checkRedisCommand("HSCAN count 0 COUNT 10", ro)).toHaveLength(5);
		// Later arguments may start with "-" (values).
		expect(checkRedisCommand("SET k -1", rw)).toEqual(["SET", "k", "-1"]);
	});

	it("clamps maxTimeMS of reading Mongo commands to the console timeout", () => {
		const script = mongoConsoleScript({
			command: '{"find": "users"}',
			database: "app",
			readOnly: true,
			maxTimeMs: 15000,
		});
		expect(script).toContain('["find","aggregate","count","distinct"]');
		const line = script
			.split("\n")
			.find((item) => item.includes("command.maxTimeMS ="));
		const apply = (command: Record<string, unknown>) => {
			new Function("command", line ?? "")(command);
			return command.maxTimeMS;
		};
		expect(apply({ find: "u" })).toBe(15000);
		expect(apply({ find: "u", maxTimeMS: 0 })).toBe(15000);
		expect(apply({ find: "u", maxTimeMS: 999999999 })).toBe(15000);
		expect(apply({ find: "u", maxTimeMS: 2500 })).toBe(2500);
		expect(apply({ aggregate: "u", maxTimeMS: "x" })).toBe(15000);
		expect(apply({ insert: "u" })).toBeUndefined();
	});

	it("masks values in audit text", () => {
		expect(
			maskMongoCommand(
				'{"createUser": "x", "pwd": "s3cret", "roles": [{"role": "read", "db": "app"}], "n": 2}',
			),
		).toBe(
			'{"createUser":"…","pwd":"…","roles":[{"role":"…","db":"…"}],"n":2}',
		);
		expect(maskMongoCommand("not json")).toBe("(unreadable command)");
		expect(maskRedisCommand(["SET", "token", "s3cret", "EX", "60"])).toBe(
			"SET token … … …",
		);
	});
});
