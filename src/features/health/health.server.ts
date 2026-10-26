import { sql } from "drizzle-orm";
import { db } from "#/db/index.ts";

/**
 * Liveness for the container health check (Dockerfile HEALTHCHECK, used by
 * the updater to tell a broken version): 200 once the server answers and
 * reaches its database. No data, no version.
 */
export async function healthResponse(): Promise<Response> {
	const headers = { "Cache-Control": "no-store" };
	try {
		await db.execute(sql`select 1`);
		return Response.json({ status: "ok" }, { headers });
	} catch {
		return Response.json({ status: "unavailable" }, { status: 503, headers });
	}
}
