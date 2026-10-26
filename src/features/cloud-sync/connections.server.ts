import { desc, eq } from "drizzle-orm";
import {
	type CloudSyncProvider,
	getCloudSyncProvider,
	providerSecretFields,
} from "#/config/cloud-sync.ts";
import { describeSchemaError } from "#/config/schema-fields.ts";
import { db } from "#/db/index.ts";
import {
	type CloudConnectionTestRecord,
	cloudConnections,
} from "#/db/schema/cloud-sync.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess } from "#/features/auth/access.ts";
import { SECRET_MASK } from "#/server/services/apps/env-state.ts";
import { audit } from "#/server/services/audit.ts";
import { redactor } from "#/server/services/backup/rclone.ts";
import { cloudSyncDriver } from "#/server/services/cloud-sync/drivers.ts";
import type { CloudSyncDriver } from "#/server/services/cloud-sync/types.ts";
import { decrypt, encrypt } from "#/utils/crypto.ts";
import { AppError } from "#/utils/error.ts";
import type { CloudConnectionDTO, CloudConnectionRow } from "./schema";

/** A provider with its server driver (both must exist). */
function providerAndDriver(id: string): {
	provider: CloudSyncProvider;
	driver: CloudSyncDriver;
} {
	const provider = getCloudSyncProvider(id);
	const driver = cloudSyncDriver(id);
	if (!provider || !driver) {
		throw new AppError("CLOUD_PROVIDER_UNKNOWN", { provider: id });
	}
	return { provider, driver };
}

export async function getConnectionRow(
	actor: Actor,
	id: string,
): Promise<CloudConnectionRow> {
	const [row] = await db
		.select()
		.from(cloudConnections)
		.where(eq(cloudConnections.id, id))
		.limit(1);
	return assertCanAccess(
		actor,
		row,
		"cloud_connection.view",
		"CLOUD_CONNECTION_NOT_FOUND",
	);
}

/** Decrypted, provider-validated config (server-only: secrets). */
export function connectionConfig(row: CloudConnectionRow) {
	const { provider, driver } = providerAndDriver(row.provider);
	const parsed = provider.schema.safeParse(
		JSON.parse(decrypt(row.configEncrypted)),
	);
	if (!parsed.success) {
		throw new AppError(
			"CLOUD_CONNECTION_FIELD_INVALID",
			describeSchemaError(provider.schema, parsed.error),
		);
	}
	const config = parsed.data as Record<string, unknown>;
	const secrets = providerSecretFields(provider)
		.map((name) => config[name])
		.filter((value): value is string => typeof value === "string");
	return { provider, driver, config, secrets, redact: redactor(secrets) };
}

/** Validate a provider config; masked secrets keep their stored value. */
function validateConfig(
	providerId: string,
	input: Record<string, unknown>,
	previous: Record<string, unknown> = {},
): Record<string, unknown> {
	const { provider } = providerAndDriver(providerId);
	const merged = { ...input };
	for (const name of providerSecretFields(provider)) {
		if (merged[name] === SECRET_MASK || merged[name] === undefined) {
			merged[name] = previous[name];
		}
	}
	const parsed = provider.schema.safeParse(merged);
	if (!parsed.success) {
		throw new AppError(
			"CLOUD_CONNECTION_FIELD_INVALID",
			describeSchemaError(provider.schema, parsed.error),
		);
	}
	return parsed.data as Record<string, unknown>;
}

function maskedConfig(row: CloudConnectionRow): CloudConnectionDTO["config"] {
	const provider = getCloudSyncProvider(row.provider);
	const config = JSON.parse(
		decrypt(row.configEncrypted),
	) as CloudConnectionDTO["config"];
	for (const name of provider ? providerSecretFields(provider) : []) {
		if (config[name]) config[name] = SECRET_MASK;
	}
	return config;
}

function toConnectionDTO(row: CloudConnectionRow): CloudConnectionDTO {
	return {
		id: row.id,
		name: row.name,
		provider: row.provider,
		config: maskedConfig(row),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		lastTest: row.lastTest ?? null,
	};
}

export async function listConnections(
	actor: Actor,
): Promise<CloudConnectionDTO[]> {
	assertCanAccess(actor, "cloud_connection.view");
	const rows = await db
		.select()
		.from(cloudConnections)
		.where(eq(cloudConnections.teamId, actor.teamId))
		.orderBy(desc(cloudConnections.createdAt));
	return rows.map(toConnectionDTO);
}

export async function createConnection(
	actor: Actor,
	input: { name: string; provider: string; config: Record<string, unknown> },
): Promise<{ id: string }> {
	const config = validateConfig(input.provider, input.config);
	const [row] = await db
		.insert(cloudConnections)
		.values({
			teamId: actor.teamId,
			userId: actor.userId,
			name: input.name,
			provider: input.provider,
			configEncrypted: encrypt(JSON.stringify(config)),
		})
		.returning({ id: cloudConnections.id });
	audit({
		actor,
		action: "cloud_connection.create",
		targetType: "cloud_connection",
		targetId: row.id,
		meta: { provider: input.provider },
	});
	return row;
}

export async function updateConnection(
	actor: Actor,
	input: {
		id: string;
		name: string;
		provider: string;
		config: Record<string, unknown>;
	},
): Promise<void> {
	const row = await getConnectionRow(actor, input.id);
	if (row.provider !== input.provider) {
		throw new AppError("CLOUD_CONNECTION_PROVIDER_LOCKED");
	}
	const previous = JSON.parse(decrypt(row.configEncrypted)) as Record<
		string,
		unknown
	>;
	const config = validateConfig(row.provider, input.config, previous);
	await db
		.update(cloudConnections)
		.set({
			name: input.name,
			configEncrypted: encrypt(JSON.stringify(config)),
			// The stored test was for the old values.
			lastTest: null,
			updatedAt: new Date(),
		})
		.where(eq(cloudConnections.id, row.id));
	audit({
		actor,
		action: "cloud_connection.update",
		targetType: "cloud_connection",
		targetId: row.id,
	});
}

/** Sync history keeps the connection's name (its id becomes null). */
export async function deleteConnection(
	actor: Actor,
	id: string,
): Promise<void> {
	const row = await getConnectionRow(actor, id);
	await db.delete(cloudConnections).where(eq(cloudConnections.id, row.id));
	audit({
		actor,
		action: "cloud_connection.delete",
		targetType: "cloud_connection",
		targetId: row.id,
	});
}

/** Scrub secrets from every text of a stored test result. */
function redactRecord<T>(value: T, redact: (text: string) => string): T {
	return JSON.parse(redact(JSON.stringify(value))) as T;
}

/** Run the provider's checks from the panel; the result is stored. */
export async function testConnection(
	actor: Actor,
	id: string,
): Promise<CloudConnectionTestRecord> {
	const row = await getConnectionRow(actor, id);
	const { provider, driver, config, redact } = connectionConfig(row);
	const result = await driver.test(provider, config);
	const record = redactRecord(
		{ ...result, at: new Date().toISOString() },
		redact,
	);
	await db
		.update(cloudConnections)
		.set({ lastTest: record })
		.where(eq(cloudConnections.id, row.id));
	audit({
		actor,
		action: "cloud_connection.test",
		targetType: "cloud_connection",
		targetId: row.id,
		meta: { ok: record.ok },
	});
	return record;
}
