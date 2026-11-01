import { describe, expect, it, vi } from "vitest";

/**
 * A database app's version must be a pinned tag of the engine registry,
 * also when it comes as a bare `version` (API, restore) instead of the
 * wizard's `database` choice.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));
vi.mock("#/db/index.ts", () => ({ db: {} }));

const { databaseSourceDriver } = await import("./driver.server");

const prepare = (input: Record<string, unknown>) =>
	databaseSourceDriver.prepareCreate?.({
		actor: {} as never,
		template: {} as never,
		input: { inputs: {}, ...input } as never,
	});

describe("databaseSourceDriver.prepareCreate", () => {
	it.each([
		"postgres@16",
		"postgres@latest",
		"postgres@0.0.0",
		"nosuch@1.0",
	])("refuses the unknown version %s", async (version) => {
		await expect(prepare({ version })).rejects.toMatchObject({
			code: "DATABASE_VERSION_INVALID",
		});
	});

	it("refuses an unknown tag from the database choice", async () => {
		await expect(
			prepare({ database: { engine: "postgres", version: "16" } }),
		).rejects.toMatchObject({ code: "DATABASE_VERSION_INVALID" });
	});
});
