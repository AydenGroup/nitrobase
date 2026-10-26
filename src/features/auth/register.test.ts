import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * createUser and the pool: the setup token is read through the shared pool,
 * so it must be checked before the registration transaction (a pool
 * request made while holding the transaction's connection could starve the
 * pool under concurrent sign-ups).
 */
const state = vi.hoisted(() => ({
	inTransaction: false,
	accounts: 0,
	tokenOk: true,
	/** Whether each setup-token check ran inside the transaction. */
	tokenChecks: [] as boolean[],
	/** Pool queries made while the transaction ran. */
	poolInsideTx: 0,
}));

vi.mock("#/db/index.ts", () => {
	const chain = (result: unknown) => {
		const node: Record<string, unknown> = {};
		for (const name of ["from", "where", "values"]) {
			node[name] = () => node;
		}
		node.limit = async () => result;
		node.returning = async () => result;
		return node;
	};
	const tx = {
		execute: async () => undefined,
		select: () => chain(state.accounts ? [{ id: "u0" }] : []),
		insert: () =>
			chain([{ id: "u1", email: "a@example.com", instanceAdmin: true }]),
	};
	return {
		db: {
			transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
				state.inTransaction = true;
				try {
					return await fn(tx);
				} finally {
					state.inTransaction = false;
				}
			},
			query: {
				users: {
					findFirst: async () => {
						if (state.inTransaction) state.poolInsideTx += 1;
						return state.accounts ? { id: "u0" } : undefined;
					},
				},
			},
		},
	};
});

vi.mock("#/features/setup/setup-token.server.ts", () => ({
	setupTokenMatches: vi.fn(async () => {
		state.tokenChecks.push(state.inTransaction);
		return state.tokenOk;
	}),
	clearSetupToken: vi.fn(async () => undefined),
}));
vi.mock("#/features/servers/servers.server.ts", () => ({
	createDefaultServer: vi.fn(async () => ({})),
}));
vi.mock("#/features/teams/teams.server.ts", () => ({
	createTeamRecord: vi.fn(async () => ({ id: "t1" })),
	consumeInvite: vi.fn(async () => undefined),
}));

const { createUser } = await import("./auth.server");
const { clearSetupToken } = await import(
	"#/features/setup/setup-token.server.ts"
);

const input = {
	firstName: "Ada",
	lastName: "Admin",
	email: "a@example.com",
	password: "correct horse battery",
	confirmPassword: "correct horse battery",
	setupToken: "token",
};

beforeEach(() => {
	state.accounts = 0;
	state.tokenOk = true;
	state.tokenChecks = [];
	state.poolInsideTx = 0;
	vi.mocked(clearSetupToken).mockClear();
});

describe("first account and the setup token", () => {
	it("checks the token before the transaction, never inside it", async () => {
		await createUser(input, undefined);
		expect(state.tokenChecks).toEqual([false]);
		expect(state.poolInsideTx).toBe(0);
		// The spent token is cleared with the transaction's connection.
		expect(clearSetupToken).toHaveBeenCalledTimes(1);
		expect(vi.mocked(clearSetupToken).mock.calls[0]?.[0]).toBeDefined();
	});

	it("refuses a wrong token without opening the transaction", async () => {
		state.tokenOk = false;
		await expect(createUser(input, undefined)).rejects.toMatchObject({
			code: "SETUP_TOKEN_INVALID",
		});
		expect(state.tokenChecks).toEqual([false]);
		expect(clearSetupToken).not.toHaveBeenCalled();
	});
});
