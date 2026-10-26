import { describe, expect, it } from "vitest";
import { shellQuote as q } from "#/server/services/executor.ts";
import { cleanupStagingCommand, STAGING_PREFIX } from "./edge-functions";

describe("staging sweep", () => {
	it("stages under today's name", () => {
		expect(STAGING_PREFIX).toBe(".nitrobase-staging-");
	});

	it("removes leftover staging dirs", () => {
		expect(cleanupStagingCommand("supabase-0123abcd-functions", "/x")).toBe(
			`docker exec 'supabase-0123abcd-functions' sh -c ${q("cd '/x' && rm -rf -- ./.nitrobase-staging-*")} || true`,
		);
	});
});
