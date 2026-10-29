/**
 * Apply the migrations in ./drizzle (`bun run db:migrate`, run by the
 * container before the server starts).
 *
 * drizzle-kit migrate exits 1 without saying why when it cannot reach the
 * database: this prints the database's own error, and what to do for the
 * usual one, a database volume created with another POSTGRES_PASSWORD.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("[migrate] DATABASE_URL is not set");
	process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });
try {
	console.log("[migrate] applying migrations...");
	await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
	console.log("[migrate] done");
} catch (error) {
	const code = (error as { code?: string }).code;
	const cause = (error as { cause?: { code?: string; message?: string } })
		.cause;
	console.error(
		`[migrate] failed: ${cause?.message ?? (error as Error).message}`,
	);
	if ((cause?.code ?? code) === "28P01") {
		console.error(
			"[migrate] the database was created with another POSTGRES_PASSWORD: put back the .env it was created with, or remove the old database volume (docker volume rm nitrobase_postgres_data) to start empty",
		);
	}
	process.exitCode = 1;
} finally {
	await pool.end();
}
