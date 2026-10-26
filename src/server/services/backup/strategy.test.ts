import { describe, expect, it } from "vitest";
import { postgresStrategy } from "./strategy";

describe("postgresStrategy", () => {
	const strategy = postgresStrategy({
		id: "pg",
		user: "supabase_admin",
		database: "postgres",
	});

	it("dumps roles then each database with --clean, never DROP DATABASE", () => {
		const command = strategy.dumpCommand("supabase-1-db");
		expect(command.startsWith("docker exec 'supabase-1-db' sh -c ")).toBe(true);
		expect(command).toContain(
			'pg_dumpall -U "$1" --globals-only --clean --if-exists',
		);
		expect(command).toContain('pg_dump -U "$1" -d "$db" --clean --if-exists');
		expect(command).not.toContain("--create");
		expect(command.endsWith("sh 'supabase_admin' 'postgres'")).toBe(true);
		expect(strategy.file).toBe("cluster.sql");
	});

	it("restores from stdin with psql, continuing past errors", () => {
		expect(strategy.restoreCommand("supabase-1-db")).toBe(
			"docker exec -i 'supabase-1-db' psql -X -q -U 'supabase_admin' -d 'postgres' -v ON_ERROR_STOP=0",
		);
	});

	it("validates names", () => {
		expect(() => strategy.dumpCommand("x; rm -rf /")).toThrow();
		expect(() =>
			postgresStrategy({
				id: "pg",
				user: "Robert'); --",
				database: "postgres",
			}),
		).toThrow();
	});
});
