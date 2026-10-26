import { describe, expect, it } from "vitest";
import {
	createSetupTokens,
	generateSetupToken,
	SETUP_TOKEN_LOG_LABEL,
	tokensEqual,
} from "./setup-token";

function setup(options: { env?: string; accounts?: boolean } = {}) {
	const state = {
		env: options.env,
		accounts: options.accounts ?? false,
		stored: null as string | null,
		saves: 0,
		clears: 0,
		logs: [] as string[],
	};
	const tokens = createSetupTokens({
		envToken: () => state.env,
		accountExists: async () => state.accounts,
		load: async () => state.stored,
		save: async (token) => {
			state.saves += 1;
			state.stored = token;
		},
		clear: async () => {
			state.clears += 1;
			state.stored = null;
		},
		panelUrl: () => "http://203.0.113.7:3000",
		log: (line) => state.logs.push(line),
	});
	return { state, tokens };
}

describe("setup token", () => {
	it("generates 32 random hex characters", () => {
		const token = generateSetupToken();
		expect(token).toMatch(/^[0-9a-f]{32}$/);
		expect(generateSetupToken()).not.toBe(token);
	});

	it("compares trimmed values and refuses empty ones", () => {
		expect(tokensEqual(" abc123 ", "abc123")).toBe(true);
		expect(tokensEqual("abc124", "abc123")).toBe(false);
		expect(tokensEqual("abc", "abc123")).toBe(false);
		expect(tokensEqual("", "abc123")).toBe(false);
		expect(tokensEqual("   ", "abc123")).toBe(false);
		expect(tokensEqual(null, "abc123")).toBe(false);
		expect(tokensEqual(undefined, "abc123")).toBe(false);
	});

	it("generates, stores and logs a token at boot when none is configured", async () => {
		const { state, tokens } = setup();
		await tokens.boot();
		expect(state.stored).toMatch(/^[0-9a-f]{32}$/);
		expect(state.logs).toEqual([
			`${SETUP_TOKEN_LOG_LABEL}: ${state.stored} (open http://203.0.113.7:3000 to create the first account)`,
		]);
		expect(await tokens.matches(state.stored)).toBe(true);
		expect(await tokens.matches("wrong")).toBe(false);
		expect(await tokens.matches(undefined)).toBe(false);
		// Logged once per boot.
		await tokens.boot();
		expect(state.logs).toHaveLength(1);
		expect(state.saves).toBe(1);
	});

	it("keeps the stored token across a restart", async () => {
		const first = setup();
		await first.tokens.boot();
		const restarted = setup();
		restarted.state.stored = first.state.stored;
		await restarted.tokens.boot();
		expect(restarted.state.saves).toBe(0);
		expect(restarted.state.logs[0]).toContain(first.state.stored as string);
		expect(await restarted.tokens.matches(first.state.stored)).toBe(true);
	});

	it("generates lazily (fail closed) when the boot step has not run", async () => {
		const { state, tokens } = setup();
		expect(await tokens.matches("guess")).toBe(false);
		expect(state.stored).toMatch(/^[0-9a-f]{32}$/);
		expect(state.logs).toHaveLength(1);
	});

	it("generates one token for concurrent callers", async () => {
		const { state, tokens } = setup();
		const [a, b] = await Promise.all([tokens.current(), tokens.current()]);
		expect(a).toBe(b);
		expect(state.saves).toBe(1);
	});

	it("lets SETUP_TOKEN win and never logs its value", async () => {
		const env = "installer-token-0123456789";
		const { state, tokens } = setup({ env });
		state.stored = "leftover-generated-token";
		await tokens.boot();
		expect(state.saves).toBe(0);
		expect(state.logs).toHaveLength(1);
		expect(state.logs[0]).toContain(SETUP_TOKEN_LOG_LABEL);
		expect(state.logs[0]).not.toContain(env);
		expect(await tokens.matches(env)).toBe(true);
		expect(await tokens.matches("leftover-generated-token")).toBe(false);
	});

	it("is cleared and ignored once an account exists", async () => {
		const { state, tokens } = setup();
		await tokens.boot();
		const token = state.stored;
		state.accounts = true;
		expect(await tokens.matches(token)).toBe(false);
		await tokens.boot();
		expect(state.clears).toBe(1);
		expect(state.stored).toBeNull();
		expect(await tokens.current()).toBeNull();
	});

	it("forgets the spent token after the first account", async () => {
		const { state, tokens } = setup();
		await tokens.boot();
		const spent = state.stored;
		// The first account's transaction deleted the row.
		state.stored = null;
		tokens.forget();
		const next = await tokens.current();
		expect(next).not.toBe(spent);
	});

	it("retries generation after a storage error", async () => {
		const { state, tokens } = setup();
		let fail = true;
		const flaky = createSetupTokens({
			envToken: () => undefined,
			accountExists: async () => false,
			load: async () => {
				if (fail) throw new Error("database is starting");
				return state.stored;
			},
			save: async (token) => {
				state.stored = token;
			},
			clear: async () => {},
			panelUrl: () => "http://x",
			log: () => {},
		});
		await expect(flaky.current()).rejects.toThrow(/starting/);
		fail = false;
		expect(await flaky.current()).toMatch(/^[0-9a-f]{32}$/);
		expect(tokens).toBeDefined();
	});
});
