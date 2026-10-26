import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// HTTP cache for template sources (GitHub version lists, trees, blobs).
// Keys: API path for lists (TTL + ETag), `blob:<sha>` / tree paths (immutable).
export const templatesCache = pgTable("templates_cache", {
	key: text("key").primaryKey(),
	etag: text("etag"),
	payload: jsonb("payload").notNull(),
	fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
});
