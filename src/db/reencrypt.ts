import { eq, getTableColumns } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { decryptWithSecret, encryptWithSecret } from "#/utils/crypto.ts";
import { internalError } from "#/utils/plain-errors.ts";
import { encryptedColumns } from "./encrypted-columns";

export interface ReencryptOptions {
	oldSecret: string;
	newSecret: string;
}

/**
 * New ciphertext of one stored value (`oldSecret` → `newSecret`), or
 * undefined when it is not a string (nothing stored).
 */
export function reencryptValue(
	value: unknown,
	options: ReencryptOptions,
): string | undefined {
	if (typeof value !== "string") return undefined;
	return encryptWithSecret(
		options.newSecret,
		decryptWithSecret(options.oldSecret, value),
	);
}

/**
 * Re-encrypt every stored secret (all columns in `encrypted-columns.ts`)
 * from `oldSecret` to `newSecret` in one transaction; rows are locked while
 * rewritten. Returns the rows changed.
 * Used by scripts/rotate-encryption-key.ts and the first-run restore.
 */
export async function reencryptAll(
	// biome-ignore lint/suspicious/noExplicitAny: any schema
	db: NodePgDatabase<any>,
	options: ReencryptOptions,
): Promise<number> {
	const reencrypt = (value: unknown) => reencryptValue(value, options);
	let count = 0;
	await db.transaction(async (tx) => {
		for (const entry of encryptedColumns) {
			const selected = Object.fromEntries([
				["id", entry.id],
				...entry.columns.map((column) => [column.name, column]),
				...(entry.jsonField ? [["json", entry.jsonField.column]] : []),
			]);
			// Row locks: concurrent writers wait until this transaction commits.
			const rows = (await tx
				.select(selected)
				.from(entry.table)
				.for("update")) as Record<string, unknown>[];
			for (const row of rows) {
				const updates: Record<string, unknown> = {};
				for (const column of entry.columns) {
					const next = reencrypt(row[column.name]);
					if (next !== undefined) updates[columnKey(entry, column.name)] = next;
				}
				if (entry.jsonField) {
					const json = row.json as Record<string, unknown> | null;
					const next = reencryptJsonField(json, entry.jsonField, options);
					if (next) {
						updates[columnKey(entry, entry.jsonField.column.name)] = next;
					}
				}
				if (Object.keys(updates).length === 0) continue;
				await tx
					.update(entry.table)
					.set(updates as never)
					.where(eq(entry.id, row.id));
				count++;
			}
		}
	});
	return count;
}

/**
 * New content of a jsonb field holding an encrypted value, or undefined
 * when nothing changes: the value re-encrypted, and a legacy plain value
 * (`plainKey`) encrypted into `key` (dropped when `key` is already set).
 */
export function reencryptJsonField(
	json: Record<string, unknown> | null,
	field: { key: string; plainKey?: string },
	options: ReencryptOptions,
): Record<string, unknown> | undefined {
	if (!json) return undefined;
	let next: Record<string, unknown> | undefined;
	const value = reencryptValue(json[field.key], options);
	if (value !== undefined) next = { ...json, [field.key]: value };
	if (field.plainKey && field.plainKey in json) {
		const { [field.plainKey]: plain, ...rest } = next ?? json;
		next = rest;
		if (
			value === undefined &&
			plain &&
			typeof plain === "object" &&
			Object.keys(plain).length > 0
		) {
			next[field.key] = encryptWithSecret(
				options.newSecret,
				JSON.stringify(plain),
			);
		}
	}
	return next;
}

/** Drizzle property name (camelCase) of a SQL column name in a table. */
function columnKey(
	entry: (typeof encryptedColumns)[number],
	sqlName: string,
): string {
	const columns = getTableColumns(entry.table);
	const key = Object.keys(columns).find(
		(name) => columns[name].name === sqlName,
	);
	if (!key) throw internalError(`Unknown column ${sqlName}`);
	return key;
}
