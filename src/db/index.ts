import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/**
 * Longest wait for a pool connection (ms; env DATABASE_CONNECT_TIMEOUT_MS):
 * a request fails instead of hanging forever when the pool is exhausted.
 */
const CONNECT_TIMEOUT_MS =
	Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 30_000;

/**
 * Shared Drizzle client (node-postgres pool from DATABASE_URL). Passing the
 * full schema enables the relational `db.query.*` API.
 */
export const db = drizzle({
	connection: {
		connectionString: process.env.DATABASE_URL,
		connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
	},
	schema,
});
