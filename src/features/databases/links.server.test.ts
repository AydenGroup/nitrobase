import { describe, expect, it, vi } from "vitest";

vi.mock("#/db/index.ts", () => ({ db: {} }));

const { addLinkEnv } = await import("./links.server");

describe("addLinkEnv", () => {
	it("adds a link's env to the app's", () => {
		const env: Record<string, string> = { DATABASE_URL: "postgres://a" };
		addLinkEnv(env, { CACHE_URL: "redis://b", CACHE_HOST: "b" });
		expect(env).toEqual({
			DATABASE_URL: "postgres://a",
			CACHE_URL: "redis://b",
			CACHE_HOST: "b",
		});
	});

	it("refuses two links that set the same variable", () => {
		const env: Record<string, string> = { DATABASE_URL: "postgres://a" };
		expect(() => addLinkEnv(env, { DATABASE_URL: "postgres://b" })).toThrow(
			expect.objectContaining({
				code: "DATABASE_LINK_ENV_TWO_LINKS",
				params: { name: "DATABASE_URL" },
			}),
		);
		expect(env).toEqual({ DATABASE_URL: "postgres://a" });
	});
});
