/**
 * Rotate ENCRYPTION_KEY: re-encrypt every stored secret (all columns in
 * `src/db/encrypted-columns.ts`) from the old key to the new one in one
 * transaction.
 *
 *   OLD_ENCRYPTION_KEY='<current key>' \
 *   ENCRYPTION_KEY="$(openssl rand -base64 32)" \
 *   DATABASE_URL=postgresql://... bun scripts/rotate-encryption-key.ts
 *
 * Inside the prod container: docker compose -f docker-compose.prod.yml run --rm
 *   -e OLD_ENCRYPTION_KEY=... app bun scripts/rotate-encryption-key.ts
 *
 * Stop the panel first: it caches nothing, but a running instance keeps
 * writing with the key it started with. The script refuses to run while
 * other sessions are connected to the database (ROTATE_FORCE=1 overrides),
 * and locks every row it rewrites (SELECT … FOR UPDATE), so a concurrent
 * write can never be overwritten with a stale value.
 *
 * `env.enc` inside existing backup archives stays encrypted with the key
 * that was current when the backup ran: after a rotation, keep the old key
 * in ENCRYPTION_KEY_PREVIOUS until those backups have aged out.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { APP_NAME } from "../src/config/shared.ts";
import { reencryptAll } from "../src/db/reencrypt.ts";

const oldSecret = process.env.OLD_ENCRYPTION_KEY;
const newSecret = process.env.ENCRYPTION_KEY;
if (!oldSecret || !newSecret || !process.env.DATABASE_URL) {
	console.error("Set OLD_ENCRYPTION_KEY, ENCRYPTION_KEY and DATABASE_URL");
	process.exit(1);
}
if (newSecret.length < 32 || newSecret === oldSecret) {
	console.error("ENCRYPTION_KEY must be a new value of at least 32 characters");
	process.exit(1);
}

const db = drizzle(process.env.DATABASE_URL);

// A running panel keeps a connection pool open on the same database.
const others = await db.execute<{ count: number }>(
	sql`select count(*)::int as count from pg_stat_activity
		where datname = current_database() and pid <> pg_backend_pid()
		and backend_type = 'client backend'`,
);
const connected = others.rows[0]?.count ?? 0;
if (connected > 0 && process.env.ROTATE_FORCE !== "1") {
	console.error(
		`${connected} other connection(s) to this database: stop ${APP_NAME} first (docker compose stop app), or set ROTATE_FORCE=1 if they are not the panel.`,
	);
	process.exit(1);
}

const count = await reencryptAll(db, { oldSecret, newSecret });

console.log(
	`Re-encrypted ${count} rows. Restart ${APP_NAME} with the new ENCRYPTION_KEY, and set ENCRYPTION_KEY_PREVIOUS to the old key until every backup made before this rotation has aged out (their env.enc still uses the old key).`,
);
process.exit(0);
