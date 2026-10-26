import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { serverEngines } = await import("./engines");

/**
 * OneDev #11 (BUG-014) follow-up: the official images read their login
 * variables only when they initialise an empty data directory, so those
 * are `initial_only`. Values the panel (or the server) applies on every
 * start stay editable as before: the console login (re-created after each
 * deploy) and Valkey's `requirepass` (passed on every start).
 */
const flags = (engine: keyof typeof serverEngines) =>
	Object.fromEntries(
		Object.entries(serverEngines[engine].variables).map(([name, variable]) => [
			name,
			variable.initial_only ?? false,
		]),
	);

describe("database engine initial_only variables", () => {
	it("postgres: the POSTGRES_* login", () => {
		expect(flags("postgres")).toEqual({
			DB_USER: true,
			DB_NAME: true,
			DB_PASSWORD: true,
		});
	});

	it.each([
		"mysql",
		"mariadb",
	] as const)("%s: the user and root logins, not the console login", (engine) => {
		expect(flags(engine)).toEqual({
			DB_USER: true,
			DB_NAME: true,
			DB_PASSWORD: true,
			DB_ROOT_PASSWORD: true,
			CONSOLE_PASSWORD: false,
		});
	});

	it("mongodb: the MONGO_INITDB_* login, not the console login", () => {
		expect(flags("mongodb")).toEqual({
			DB_USER: true,
			DB_NAME: true,
			DB_PASSWORD: true,
			CONSOLE_PASSWORD: false,
		});
	});

	it("valkey: requirepass is applied on every start", () => {
		expect(flags("valkey")).toEqual({ DB_PASSWORD: false });
	});
});
