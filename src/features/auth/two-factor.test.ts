import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

// In-memory stand-ins for the two tables verifySecondFactor touches.
const state = { recoveryUsed: false, lastStep: null as number | null };

vi.mock("#/db/index.ts", () => {
	const select = () => ({
		from: () => ({
			where: () => ({
				limit: async () => [
					{
						id: "u1",
						totpEnabledAt: new Date(),
						totpSecretEncrypted: "enc",
						totpLastStep: state.lastStep,
					},
				],
			}),
		}),
	});
	const update = (table: { _name?: string }) => ({
		set: () => ({
			where: () => ({
				returning: async () => {
					if (table._name === "recovery") {
						if (state.recoveryUsed) return [];
						state.recoveryUsed = true;
						return [{ id: "r1" }];
					}
					return [{ id: "u1" }];
				},
			}),
		}),
	});
	return { db: { select, update } };
});
vi.mock("#/db/schema/user.ts", () => ({
	users: { _name: "users", id: "id", totpLastStep: "totp_last_step" },
	userRecoveryCodes: {
		_name: "recovery",
		userId: "user_id",
		codeHash: "code_hash",
		usedAt: "used_at",
	},
}));
vi.mock("drizzle-orm", () => ({
	and: () => ({}),
	eq: () => ({}),
	isNull: () => ({}),
	sql: () => ({}),
}));
vi.mock("#/config/server.ts", () => ({
	getConfig: () => ({
		TWO_FACTOR_RATE_PER_USER: 5,
		TWO_FACTOR_RATE_WINDOW_MS: 60_000,
		TOTP_WINDOW: 1,
	}),
}));
vi.mock("#/server/services/audit.ts", () => ({ audit: vi.fn() }));
vi.mock("#/utils/crypto.ts", () => ({
	decrypt: () => "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
	encrypt: (value: string) => value,
}));
vi.mock("#/libs/error-codes.ts", () => ({ errorCodes: {} }));
vi.mock("qrcode", () => ({ default: {} }));
// Persistence is covered by rate-limit.test.ts: memory-only here.
vi.mock("./rate-limits.server", async () => {
	const { createRateLimiter } = await import("#/server/services/rate-limit.ts");
	return {
		persistentRateLimiter: (
			_scope: string,
			options: { limit: number; windowMs: number },
		) => ({ ...createRateLimiter(options), ready: async () => {} }),
	};
});

const { verifySecondFactor } = await import("./two-factor.server");

describe("verifySecondFactor", () => {
	it("accepts a recovery code once, then rejects it", async () => {
		await expect(verifySecondFactor("u1", "ABCDE-FGHJK")).resolves.toBe(
			"recovery",
		);
		await expect(verifySecondFactor("u1", "ABCDE-FGHJK")).rejects.toThrow(
			/AUTH_2FA_INVALID/,
		);
	});

	it("rate-limits repeated failures", async () => {
		for (let i = 0; i < 5; i++) {
			await verifySecondFactor("u2", "000000").catch(() => undefined);
		}
		await expect(verifySecondFactor("u2", "000000")).rejects.toThrow(
			/AUTH_RATE_LIMITED/,
		);
	});
});
