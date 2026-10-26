import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/**
 * Shared Drizzle client (node-postgres pool from DATABASE_URL). Passing the
 * full schema enables the relational `db.query.*` API.
 */
export const db = drizzle(process.env.DATABASE_URL, { schema });
