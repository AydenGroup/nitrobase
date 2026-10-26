import { describe, expect, it } from "vitest";
import { buildDatabaseStrategy } from "./db-strategies";
import { postgresStrategy } from "./strategy";

describe("database strategies", () => {
	it("postgres cluster mode is the former Supabase dump, byte for byte", () => {
		const generic = buildDatabaseStrategy({
			type: "postgres",
			service: "db",
			mode: "cluster",
			user: "supabase_admin",
			database: "postgres",
			legacy_ids: ["supabase-pg-dumpall"],
		});
		const former = postgresStrategy({
			id: "supabase-pg-dumpall",
			user: "supabase_admin",
			database: "postgres",
		});
		expect(generic.dumpCommand("app-db")).toBe(former.dumpCommand("app-db"));
		expect(generic.restoreCommand("app-db")).toBe(
			former.restoreCommand("app-db"),
		);
		expect(generic.file).toBe(former.file);
		expect(generic.accepts).toEqual([
			"postgres-cluster",
			"supabase-pg-dumpall",
		]);
	});

	it("postgres database mode dumps one database", () => {
		const strategy = buildDatabaseStrategy({
			type: "postgres",
			service: "db",
			mode: "database",
			user: "n8n",
			database: "n8n",
		});
		expect(strategy.dumpCommand("x-db")).toBe(
			"docker exec 'x-db' pg_dump -U 'n8n' -d 'n8n' --clean --if-exists --quote-all-identifiers",
		);
		const restore = strategy.restoreCommand("x-db");
		expect(restore).toMatch(/^docker exec -i 'x-db' sh -c /);
		// Creates the database when the fresh cluster doesn't have it.
		expect(restore).toContain("createdb");
		// Default: errors are counted, the restore continues.
		expect(restore).toContain("ON_ERROR_STOP=0");
		expect(strategy.strict).toBe(false);
		const strict = buildDatabaseStrategy({
			type: "postgres",
			service: "db",
			mode: "database",
			database: "n8n",
			strict: true,
		});
		expect(strict.restoreCommand("x-db")).toContain(
			"ON_ERROR_STOP=1 --single-transaction",
		);
		expect(strict.strict).toBe(true);
		expect(
			buildDatabaseStrategy({ type: "mysql", service: "db" }).restoreCommand(
				"y",
			),
		).toContain("--force");
		expect(restore).toMatch(/'n8n' 'n8n' 'postgres'$/);
	});

	it("mysql/mariadb read the password inside the container, never on our command line", () => {
		const strategy = buildDatabaseStrategy({
			type: "mariadb",
			service: "db",
			databases: ["app"],
		});
		const dump = strategy.dumpCommand("x-db");
		expect(dump).toContain("printenv MARIADB_ROOT_PASSWORD");
		expect(dump).toContain("mariadb-dump");
		expect(dump).toContain("--databases");
		expect(strategy.restoreCommand("x-db")).toMatch(
			/^docker exec -i 'x-db' sh -c/,
		);
		expect(
			buildDatabaseStrategy({ type: "mysql", service: "db" }).dumpCommand("y"),
		).toContain("--all-databases");
	});

	it("sqlite backs up a file and restarts the service after a restore", () => {
		const strategy = buildDatabaseStrategy({
			type: "sqlite",
			service: "app",
			path: "/data/app.db",
		});
		expect(strategy.dumpCommand("x-app")).toContain(".backup");
		expect(strategy.restartAfterRestore).toBe(true);
	});

	it("validates parameters and types", () => {
		expect(() =>
			buildDatabaseStrategy({ type: "oracle", service: "db" }),
		).toThrow(/Unknown database dump type/);
		expect(() =>
			buildDatabaseStrategy({ type: "postgres", service: "db", user: "x; rm" }),
		).toThrow(/backup.database.user/);
		expect(() =>
			buildDatabaseStrategy({
				type: "mysql",
				service: "db",
				password_env: "$(id)",
			}),
		).toThrow(/password_env/);
		expect(() =>
			buildDatabaseStrategy({ type: "sqlite", service: "db", path: "../x" }),
		).toThrow(/path/);
	});

	it("redis fetches an RDB snapshot and swaps it in on restore", () => {
		const strategy = buildDatabaseStrategy({ type: "redis", service: "db" });
		const dump = strategy.dumpCommand("x-db");
		expect(dump).toMatch(/^docker exec 'x-db' sh -c /);
		expect(dump).toContain("printenv VALKEY_PASSWORD");
		expect(dump).toContain("--rdb");
		const restore = strategy.restoreCommand("x-db");
		expect(restore).toMatch(/^docker exec -i 'x-db' sh -c /);
		expect(restore).toContain("CONFIG SET appendonly no");
		expect(restore).toContain("appendonlydir");
		expect(strategy.restartAfterRestore).toBe(true);
		expect(strategy.accepts).toEqual(["redis-rdb"]);
	});

	it("mongodb dumps an archive, password only in a temp config file", () => {
		const strategy = buildDatabaseStrategy({ type: "mongodb", service: "db" });
		const dump = strategy.dumpCommand("x-db");
		expect(dump).toContain("mongodump --quiet --config");
		expect(dump).toContain("--archive");
		expect(dump).toContain("printenv MONGO_INITDB_ROOT_PASSWORD");
		expect(dump).not.toMatch(/--password/);
		expect(strategy.restoreCommand("x-db")).toContain(
			"mongorestore --quiet --config",
		);
		expect(strategy.restoreCommand("x-db")).toContain("--archive --drop");
		expect(() =>
			buildDatabaseStrategy({
				type: "mongodb",
				service: "db",
				user_env: "a b",
			}),
		).toThrow();
	});

	it("mongodb writes the password as an escaped YAML string (real sh)", async () => {
		const { spawnSync } = await import("node:child_process");
		const command = buildDatabaseStrategy({
			type: "mongodb",
			service: "db",
		}).dumpCommand("c");
		const inner = command
			.replace(/^docker exec 'c' sh -c /, "")
			.slice(1, -1)
			.replace(/'\\''/g, "'")
			.replace(/mongodump.*?; s=\$\?/, 'cat "$f"; s=$?');
		const run = spawnSync("sh", ["-c", inner], {
			env: {
				...process.env,
				MONGO_INITDB_ROOT_PASSWORD: 'a"b\\c',
				MONGO_INITDB_ROOT_USERNAME: "u",
			},
			encoding: "utf8",
		});
		expect(run.stdout).toBe('password: "a\\"b\\\\c"\n');
	});
});
