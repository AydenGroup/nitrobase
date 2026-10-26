import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Instance settings (typed via the settings registry). Secret values are
// stored as `{ encrypted: "<ciphertext>" }`.
export const settings = pgTable("settings", {
	key: text("key").primaryKey(),
	value: jsonb("value").notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
