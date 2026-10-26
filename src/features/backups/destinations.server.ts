import { randomBytes } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { getDestinationDriver, secretFields } from "#/config/backup-drivers.ts";
import { hiddenFileName } from "#/config/identifiers.ts";
import { describeSchemaError } from "#/config/schema-fields.ts";
import { db } from "#/db/index.ts";
import {
	backupDestinations,
	backupPolicies,
	backups,
	type DestinationTestRecord,
} from "#/db/schema/backups.ts";
import { servers } from "#/db/schema/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess } from "#/features/auth/access.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { SECRET_MASK } from "#/server/services/apps/env-state.ts";
import { audit } from "#/server/services/audit.ts";
import { summarizeRcloneError } from "#/server/services/backup/rclone.ts";
import {
	checkEndpointHost,
	endpointHostOf,
} from "#/server/services/endpoint-guard.ts";
import { decrypt, encrypt } from "#/utils/crypto.ts";
import { AppError, toolOutputError } from "#/utils/error.ts";
import { newWorkDir, openRclone } from "./rclone.server";
import type {
	DestinationDTO,
	DestinationRow,
	DestinationTestResult,
} from "./schema";

export async function getDestinationRow(
	actor: Actor,
	id: string,
): Promise<DestinationRow> {
	const [row] = await db
		.select()
		.from(backupDestinations)
		.where(eq(backupDestinations.id, id))
		.limit(1);
	return assertCanAccess(
		actor,
		row,
		"backup.view",
		"BACKUP_DESTINATION_NOT_FOUND",
	);
}

/** Validate a driver config; masked secrets keep their stored value. */
function validateConfig(
	type: string,
	input: Record<string, unknown>,
	previous: Record<string, unknown> = {},
): Record<string, unknown> {
	const driver = getDestinationDriver(type);
	if (!driver) {
		throw new AppError("DESTINATION_TYPE_UNKNOWN", { type });
	}
	const merged = { ...input };
	for (const name of secretFields(driver)) {
		if (merged[name] === SECRET_MASK || merged[name] === undefined) {
			merged[name] = previous[name];
		}
	}
	const parsed = driver.schema.safeParse(merged);
	if (!parsed.success) {
		throw new AppError(
			"DESTINATION_FIELD_INVALID",
			describeSchemaError(driver.schema, parsed.error),
		);
	}
	return parsed.data as Record<string, unknown>;
}

/**
 * Save-time SSRF check: a custom endpoint must resolve to public addresses
 * unless "private or plain-HTTP endpoint" is on (sends re-check anyway).
 */
async function assertPublicEndpoint(config: Record<string, unknown>) {
	const host = endpointHostOf(config.endpoint);
	if (!host) return;
	const verdict = await checkEndpointHost(host, {
		allowPrivate: config.privateEndpoint === true,
	});
	if (verdict === "private") throw new AppError("ENDPOINT_PRIVATE", { host });
	if (verdict === "unresolved") {
		throw new AppError("ENDPOINT_UNRESOLVED", { host });
	}
}

function maskedConfig(row: DestinationRow): DestinationDTO["config"] {
	const driver = getDestinationDriver(row.type);
	const config = JSON.parse(
		decrypt(row.configEncrypted),
	) as DestinationDTO["config"];
	for (const name of driver ? secretFields(driver) : []) {
		if (config[name]) config[name] = SECRET_MASK;
	}
	return config;
}

export async function listDestinations(
	actor: Actor,
): Promise<DestinationDTO[]> {
	const rows = await db
		.select()
		.from(backupDestinations)
		.where(eq(backupDestinations.teamId, actor.teamId))
		.orderBy(backupDestinations.name);
	const counts = await db
		.select({ id: backups.destinationId, total: count() })
		.from(backups)
		.where(eq(backups.teamId, actor.teamId))
		.groupBy(backups.destinationId);
	const byId = new Map(counts.map((row) => [row.id, row.total]));
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		type: row.type,
		config: maskedConfig(row),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		backups: byId.get(row.id) ?? 0,
		lastTest: row.lastTest ?? null,
	}));
}

export async function createDestination(
	actor: Actor,
	input: { name: string; type: string; config: Record<string, unknown> },
): Promise<{ id: string }> {
	const config = validateConfig(input.type, input.config);
	await assertPublicEndpoint(config);
	const [row] = await db
		.insert(backupDestinations)
		.values({
			teamId: actor.teamId,
			userId: actor.userId,
			name: input.name,
			type: input.type,
			configEncrypted: encrypt(JSON.stringify(config)),
		})
		.returning({ id: backupDestinations.id });
	audit({
		actor,
		action: "backup.destination.create",
		targetType: "backup_destination",
		targetId: row.id,
		meta: { type: input.type },
	});
	return row;
}

export async function updateDestination(
	actor: Actor,
	input: {
		id: string;
		name: string;
		type: string;
		config: Record<string, unknown>;
	},
): Promise<void> {
	const row = await getDestinationRow(actor, input.id);
	if (row.type !== input.type) {
		throw new AppError("DESTINATION_TYPE_LOCKED");
	}
	const previous = JSON.parse(decrypt(row.configEncrypted)) as Record<
		string,
		unknown
	>;
	const config = validateConfig(row.type, input.config, previous);
	await assertPublicEndpoint(config);
	await db
		.update(backupDestinations)
		.set({
			name: input.name,
			configEncrypted: encrypt(JSON.stringify(config)),
			updatedAt: new Date(),
		})
		.where(eq(backupDestinations.id, row.id));
	audit({
		actor,
		action: "backup.destination.update",
		targetType: "backup_destination",
		targetId: row.id,
	});
}

export async function deleteDestination(
	actor: Actor,
	id: string,
): Promise<void> {
	const row = await getDestinationRow(actor, id);
	const [used] = await db
		.select({ total: count() })
		.from(backups)
		.where(eq(backups.destinationId, row.id));
	const [scheduled] = await db
		.select({ total: count() })
		.from(backupPolicies)
		.where(eq(backupPolicies.destinationId, row.id));
	if ((used?.total ?? 0) > 0 || (scheduled?.total ?? 0) > 0) {
		throw new AppError("BACKUP_DESTINATION_IN_USE");
	}
	await db.delete(backupDestinations).where(eq(backupDestinations.id, row.id));
	audit({
		actor,
		action: "backup.destination.delete",
		targetType: "backup_destination",
		targetId: row.id,
	});
}

/** The given server, or the user's first ready one. */
export async function pickServer(
	actor: Actor,
	serverId?: string,
): Promise<ServerRow> {
	if (serverId) {
		const [row] = await db
			.select()
			.from(servers)
			.where(eq(servers.id, serverId))
			.limit(1);
		const server = assertCanAccess(
			actor,
			row,
			"server.view",
			"SERVER_NOT_FOUND",
		);
		if (server.status !== "ready") throw new AppError("SERVER_NOT_READY");
		return server;
	}
	const [first] = await db
		.select()
		.from(servers)
		.where(and(eq(servers.teamId, actor.teamId), eq(servers.status, "ready")))
		.limit(1);
	if (!first) throw new AppError("SERVER_NOT_READY");
	return first;
}

async function saveTest(
	id: string,
	record: DestinationTestRecord,
): Promise<DestinationTestRecord> {
	await db
		.update(backupDestinations)
		.set({ lastTest: record })
		.where(eq(backupDestinations.id, id));
	return record;
}

/**
 * Write, read back and delete a small probe object, from a server (rclone
 * runs there, like real backups do).
 */
export async function testDestination(
	actor: Actor,
	id: string,
	serverId?: string,
): Promise<DestinationTestResult> {
	const row = await getDestinationRow(actor, id);
	const server = await pickServer(actor, serverId);
	const executor = await getExecutor(server);
	const steps: DestinationTestResult["steps"] = [];
	const probe = randomBytes(16).toString("hex");
	const key = hiddenFileName(`probe-${probe}`);
	let session: Awaited<ReturnType<typeof openRclone>> | null = null;
	try {
		session = await openRclone(executor, row, newWorkDir("test"));
		await executor.upload(probe, `${session.workDir}/probe.txt`, "0600");
		const target = session.remotePath(key);
		const write = await session.run(["copyto", "/work/probe.txt", target], {
			workReadOnly: true,
		});
		steps.push({ step: "write", ok: write.exitCode === 0 });
		if (write.exitCode !== 0) {
			throw toolOutputError(write.stderr || `exit ${write.exitCode}`);
		}
		const read = await session.run(["cat", target]);
		const readOk = read.exitCode === 0 && read.stdout.trim() === probe;
		steps.push({ step: "read", ok: readOk });
		if (!readOk) throw toolOutputError(read.stderr || `exit ${read.exitCode}`);
		const remove = await session.run(["deletefile", target]);
		steps.push({ step: "delete", ok: remove.exitCode === 0 });
		if (remove.exitCode !== 0) {
			throw toolOutputError(remove.stderr || `exit ${remove.exitCode}`);
		}
		audit({
			actor,
			action: "backup.destination.test",
			targetType: "backup_destination",
			targetId: row.id,
			meta: { ok: true, serverId: server.id },
		});
		return await saveTest(row.id, {
			ok: true,
			steps,
			kind: null,
			detail: null,
			serverName: server.name,
			at: new Date().toISOString(),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const { kind, detail } = summarizeRcloneError(
			session ? session.redact(message) : message,
		);
		return await saveTest(row.id, {
			ok: false,
			steps,
			kind,
			detail,
			serverName: server.name,
			at: new Date().toISOString(),
		});
	} finally {
		await session?.close().catch(() => undefined);
		executor.close();
	}
}
