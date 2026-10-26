import ssh2 from "ssh2";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BUG-001: a browser-autofilled panel password must never end up stored as
 * the passphrase of an unencrypted key, and keys already hit are cleaned
 * up once. `ssh_keys` rows live in memory; conditions are rendered with
 * the real Postgres dialect to find the row they address.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const state = vi.hoisted(() => ({
	rows: [] as Record<string, unknown>[],
	updates: [] as Record<string, unknown>[],
	selects: 0,
}));

vi.mock("#/db/index.ts", async () => {
	const { PgDialect } = await import("drizzle-orm/pg-core");
	const dialect = new PgDialect();
	const render = (condition: unknown) => dialect.sqlToQuery(condition as never);
	const copy = (rows: Record<string, unknown>[]) =>
		rows.map((row) => ({ ...row }));
	return {
		db: {
			select: () => ({
				from: () => ({
					where: (condition: unknown) => {
						state.selects++;
						const { params } = render(condition);
						const found = params.length
							? state.rows.filter((row) => row.id === params[0])
							: state.rows.filter((row) => row.passphraseEncrypted !== null);
						return Object.assign(Promise.resolve(copy(found)), {
							limit: async () => copy(found),
						});
					},
				}),
			}),
			update: () => ({
				set: (patch: Record<string, unknown>) => ({
					where: (condition: unknown) => ({
						returning: async () => {
							const { sql, params } = render(condition);
							const [id, other] = params;
							const row = state.rows.find(
								(item) =>
									item.id === id &&
									(sql.includes("passphrase_encrypted")
										? item.passphraseEncrypted === other
										: item.teamId === other),
							);
							if (!row) return [];
							state.updates.push(patch);
							Object.assign(row, patch);
							return [{ ...row }];
						},
					}),
				}),
			}),
		},
	};
});

// Reversible stand-in for AES-GCM (the real one needs ENCRYPTION_KEY).
vi.mock("#/utils/crypto.ts", () => ({
	encrypt: (value: string) => `enc:${value}`,
	decrypt: (value: string) => {
		if (!value.startsWith("enc:")) throw new Error("bad ciphertext");
		return value.slice(4);
	},
}));

const audit = vi.hoisted(() => vi.fn());
vi.mock("#/server/services/audit.ts", () => ({ audit }));

import type { Actor } from "#/features/auth/access.ts";
import { updateSSHKey } from "./ssh_keys.server";

const { utils } = ssh2;
const plain = utils.generateKeyPairSync("ed25519");
const locked = utils.generateKeyPairSync("ed25519", {
	passphrase: "s3cret",
	cipher: "aes256-ctr",
	rounds: 4,
});

const TEAM = "team-1";
const actor = {
	userId: "user-1",
	teamId: TEAM,
	role: "owner",
	permissions: new Set(),
	instanceAdmin: false,
	via: "session",
} as unknown as Actor;

const row = (
	id: string,
	privateKey: string,
	passphrase: string | null,
): Record<string, unknown> => ({
	id,
	teamId: TEAM,
	name: id,
	description: null,
	privateKeyEncrypted: `enc:${privateKey}`,
	passphraseEncrypted: passphrase === null ? null : `enc:${passphrase}`,
	publicKey: "",
	fingerprint: "",
});

const code = async (promise: Promise<unknown>) =>
	promise.then(
		() => "ok",
		(error: { code?: string }) => error.code ?? "unknown",
	);

beforeEach(() => {
	state.rows = [];
	state.updates = [];
	state.selects = 0;
	audit.mockClear();
});

describe("updateSSHKey", () => {
	it("stores no key material on a rename-only update", async () => {
		state.rows = [row("k1", plain.private, null)];
		await updateSSHKey(actor, "k1", { name: "qa-rsa-2" });
		expect(state.selects).toBe(0);
		expect(state.updates).toHaveLength(1);
		expect(Object.keys(state.updates[0]).sort()).toEqual(["name", "updatedAt"]);
		expect(state.rows[0].passphraseEncrypted).toBeNull();
	});

	it("refuses a passphrase for an unencrypted key", async () => {
		state.rows = [row("k1", plain.private, null)];
		expect(
			await code(updateSSHKey(actor, "k1", { passphrase: "QaAdmin#2026" })),
		).toBe("SSH_KEY_PASSPHRASE_UNEXPECTED");
		expect(state.rows[0].passphraseEncrypted).toBeNull();
	});

	it("clears a stored passphrase on request, but never for an encrypted key", async () => {
		state.rows = [
			row("k1", plain.private, "QaAdmin#2026"),
			row("k2", locked.private, "s3cret"),
		];
		await updateSSHKey(actor, "k1", { clearPassphrase: true });
		expect(state.rows[0].passphraseEncrypted).toBeNull();
		expect(
			await code(updateSSHKey(actor, "k2", { clearPassphrase: true })),
		).toBe("SSH_KEY_PASSPHRASE_REQUIRED");
		expect(state.rows[1].passphraseEncrypted).toBe("enc:s3cret");
	});
});
