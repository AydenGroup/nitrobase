import { randomBytes } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import textSamples from "#/__fixtures__/text-samples.json";
import { encryptedColumns } from "#/db/encrypted-columns.ts";
import { reencryptValue } from "#/db/reencrypt.ts";
import * as schema from "#/db/schema/index.ts";
import {
	decrypt,
	decryptWithSecret,
	encrypt,
	encryptWithSecret,
} from "./crypto";

const SECRET = "test-secret-0123456789abcdefghijklmnop";

describe("crypto", () => {
	beforeAll(() => {
		vi.stubEnv("ENCRYPTION_KEY", SECRET);
	});
	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it("writes the v3 format and reads it back", () => {
		const plain = `hunter2 ${textSamples.samples.join(" ")}`;
		const value = encrypt(plain);
		expect(value.startsWith("v3:")).toBe(true);
		expect(decrypt(value)).toBe(plain);
		expect(encrypt("x")).not.toBe(encrypt("x"));
		// Only the v3 format is read.
		expect(() => decrypt(value.slice("v3:".length))).toThrow(/format/);
		expect(() => decrypt(`v2:${value.slice("v3:".length)}`)).toThrow(/format/);
	});

	it("re-encrypts a value from one key to another", () => {
		const current = encrypt("b");
		const other = "rotated-secret-0123456789abcdefghijklm";
		const keys = { oldSecret: SECRET, newSecret: other };
		const rotated = reencryptValue(current, keys);
		expect(rotated?.startsWith("v3:")).toBe(true);
		expect(decryptWithSecret(other, rotated ?? "")).toBe("b");
		expect(reencryptValue(null, keys)).toBeUndefined();
	});

	it("round-trips empty strings", () => {
		expect(decrypt(encrypt(""))).toBe("");
	});

	it("rejects tampering, truncation, short tags and wrong keys", () => {
		const value = encrypt("payload");
		const raw = Buffer.from(value.slice(3), "base64");
		raw[raw.length - 1] ^= 1;
		expect(() => decrypt(`v3:${raw.toString("base64")}`)).toThrow();
		// iv + 8-byte tag only: too short to hold a full 16-byte tag.
		expect(() => decrypt(`v3:${randomBytes(20).toString("base64")}`)).toThrow(
			/truncated/,
		);
		expect(() =>
			decryptWithSecret("another-secret-0123456789abcdefghijk", value),
		).toThrow();
	});

	it("falls back to ENCRYPTION_KEY_PREVIOUS after a rotation", () => {
		const old1 = "old-secret-one-0123456789abcdefghijklm";
		const old2 = "old-secret-two-0123456789abcdefghijklm";
		const fromOld2 = encryptWithSecret(old2, "archive env");
		const fromOld1 = encryptWithSecret(old1, "older env");
		expect(() => decrypt(fromOld2)).toThrow();
		vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", `${old1}, ${old2}`);
		try {
			expect(decrypt(fromOld2)).toBe("archive env");
			expect(decrypt(fromOld1)).toBe("older env");
			expect(decrypt(encrypt("current"))).toBe("current");
			expect(() =>
				decrypt(encryptWithSecret("unknown-0123456789abcdefghijklmnop", "x")),
			).toThrow();
		} finally {
			vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
		}
	});

	it("re-encrypts between keys (rotation)", () => {
		const other = "rotated-secret-0123456789abcdefghijklm";
		const value = encryptWithSecret(SECRET, "s");
		const rotated = encryptWithSecret(other, decryptWithSecret(SECRET, value));
		expect(decryptWithSecret(other, rotated)).toBe("s");
		expect(() => decryptWithSecret(SECRET, rotated)).toThrow();
	});
});

describe("encrypted column registry", () => {
	it("lists every *_encrypted column of the schema", () => {
		const listed = new Set(
			encryptedColumns.flatMap((entry) =>
				entry.columns.map(
					(column) => `${getTableConfig(entry.table).name}.${column.name}`,
				),
			),
		);
		const tables = (Object.values(schema) as unknown[]).filter(
			(value): value is PgTable =>
				typeof value === "object" &&
				value !== null &&
				Symbol.for("drizzle:IsDrizzleTable") in value,
		);
		const found = tables.flatMap((table) =>
			Object.values(getTableColumns(table))
				.filter((column) => column.name.endsWith("_encrypted"))
				.map((column) => `${getTableConfig(table).name}.${column.name}`),
		);
		expect(found.length).toBeGreaterThan(0);
		for (const column of found) expect(listed, column).toContain(column);
	});
});
