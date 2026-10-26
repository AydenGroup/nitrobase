import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { jobTitle } from "#/config/job-titles.ts";
import {
	SELF_BACKUP_LAYOUT,
	SELF_BACKUP_MANIFEST,
	selfBackupKey,
} from "#/config/self-backup.ts";
import { getConfig } from "#/config/server.ts";
import { APP_NAME } from "#/config/shared.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { APP_VERSION } from "#/config/version.ts";
import { db } from "#/db/index.ts";
import { backups } from "#/db/schema/backups.ts";
import type { Actor } from "#/features/auth/access.ts";
import {
	type JobContext,
	startJob,
} from "#/features/deployments/deployments.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { clip } from "#/libs/format.ts";
import { audit } from "#/server/services/audit.ts";
import { opensslEncrypt } from "#/server/services/backup/openssl.ts";
import { rcloneFailure } from "#/server/services/backup/rclone.ts";
import {
	errorColumns,
	errorInfoOf,
	redactError,
} from "#/server/services/error-info.ts";
import { emitEvent } from "#/server/services/events/bus.ts";
import { buildTar } from "#/server/services/supabase/edge-functions.ts";
import { requireSecret } from "#/utils/env.ts";
import { AppError, internalError } from "#/utils/error.ts";
import { applyRetention } from "./backups.server";
import { getDestinationRow, pickServer } from "./destinations.server";
import { newWorkDir, openRclone } from "./rclone.server";

/**
 * Nitrobase self-backup: `pg_dump` of the panel database plus a manifest,
 * tarred, gzipped and encrypted (openssl-compatible AES-256-CBC/PBKDF2 with
 * ENCRYPTION_KEY), then uploaded through a managed server's rclone.
 * Decrypt during disaster recovery with:
 *   openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -iter <N> \
 *     -pass env:ENCRYPTION_KEY -in <file> | tar -xzf -
 */

/** libpq env (PGHOST…) from DATABASE_URL: no password in argv. */
export function pgEnvFromUrl(url: string): Record<string, string> {
	const parsed = new URL(url);
	return {
		PGHOST: parsed.hostname,
		PGPORT: parsed.port || "5432",
		PGUSER: decodeURIComponent(parsed.username),
		PGPASSWORD: decodeURIComponent(parsed.password),
		PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
		...(parsed.searchParams.get("sslmode")
			? { PGSSLMODE: parsed.searchParams.get("sslmode") as string }
			: {}),
	};
}

/** Run pg_dump (config SELF_BACKUP_PG_DUMP, split on spaces) locally. */
async function dumpPanelDatabase(): Promise<Buffer> {
	const [command, ...args] = getConfig().SELF_BACKUP_PG_DUMP.split(/\s+/);
	const url = process.env.DATABASE_URL;
	if (!url) throw internalError("DATABASE_URL is not set");
	return new Promise((resolve, reject) => {
		const child = spawn(
			command,
			[...args, "--no-owner", "--no-privileges", "--format=plain"],
			{
				env: { ...process.env, ...pgEnvFromUrl(url) },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const out: Buffer[] = [];
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? resolve(Buffer.concat(out))
				: reject(
						new AppError("SELF_BACKUP_DUMP_FAILED", {
							code: code ?? -1,
							detail: clip(err, TEXT_LIMITS.errorDetail),
						}),
					),
		);
	});
}

export async function performPanelBackup(
	input: {
		actor: Actor;
		destinationId: string;
		serverId: string;
		trigger: "manual" | "schedule";
		policyId?: string;
	},
	ctx: JobContext,
): Promise<void> {
	const config = getConfig();
	const destination = await getDestinationRow(input.actor, input.destinationId);
	const startedAt = new Date();
	const [row] = await db
		.insert(backups)
		.values({
			teamId: input.actor.teamId,
			userId: input.actor.userId,
			serverId: input.serverId,
			destinationId: destination.id,
			policyId: input.policyId ?? null,
			deploymentId: ctx.deploymentId,
			kind: "panel",
			status: "running",
			trigger: input.trigger,
			appName: APP_NAME,
		})
		.returning();
	const server = await pickServer(input.actor, input.serverId);
	const executor = await getExecutor(server);
	let session: Awaited<ReturnType<typeof openRclone>> | null = null;
	try {
		ctx.event("self_backup.dumping");
		const dump = await dumpPanelDatabase();
		const manifest = {
			format: 1,
			kind: "panel",
			createdAt: startedAt.toISOString(),
			version: APP_VERSION,
			members: [
				{
					path: SELF_BACKUP_LAYOUT.dump,
					sha256: createHash("sha256").update(dump).digest("hex"),
					size: dump.length,
				},
			],
		};
		const archive = opensslEncrypt(
			gzipSync(
				buildTar(SELF_BACKUP_LAYOUT.root, [
					{
						path: SELF_BACKUP_MANIFEST,
						content: JSON.stringify(manifest, null, 2),
					},
					{ path: SELF_BACKUP_LAYOUT.dump, content: dump },
				]),
			),
			requireSecret("ENCRYPTION_KEY"),
			config.SELF_BACKUP_PBKDF2_ITERATIONS,
		);
		const checksum = createHash("sha256").update(archive).digest("hex");
		const workDir = newWorkDir("panel");
		await ctx.setWorkDir?.(workDir);
		session = await openRclone(executor, destination, workDir);
		await executor.upload(archive, `${session.workDir}/archive.enc`, "0600");
		const stamp = startedAt
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\..*$/, "Z");
		const key = selfBackupKey(stamp, row.id.slice(0, 8));
		ctx.event("backup.uploading", { size: { $bytes: archive.length } });
		const upload = await session.run(
			["copyto", "/work/archive.enc", session.remotePath(key)],
			{ workReadOnly: true },
		);
		if (upload.exitCode !== 0) {
			throw rcloneFailure("upload", session.redact(upload.stderr), ctx);
		}
		await db
			.update(backups)
			.set({
				status: "success",
				path: key,
				sizeBytes: archive.length,
				checksum,
				durationMs: Date.now() - startedAt.getTime(),
				finishedAt: new Date(),
			})
			.where(eq(backups.id, row.id));
		// CBC has no MAC: the recorded sha256 is what detects tampering.
		ctx.event("self_backup.checksum", { sha256: checksum });
		ctx.event("self_backup.stored", {
			key,
			command: `openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -iter ${config.SELF_BACKUP_PBKDF2_ITERATIONS} -pass env:ENCRYPTION_KEY`,
		});
		if (input.policyId) {
			await applyRetention(input.policyId, session, ctx);
		}
	} catch (error) {
		const safe = session ? redactError(error, session.redact) : error;
		await db
			.update(backups)
			.set({
				status: "failed",
				...errorColumns(safe),
				durationMs: Date.now() - startedAt.getTime(),
				finishedAt: new Date(),
			})
			.where(eq(backups.id, row.id));
		emitEvent({
			id: "backup.failed",
			teamId: row.teamId,
			userId: row.userId,
			subject: row.id,
			params: {
				target: APP_NAME,
				destination: destination.name,
				error: { $error: errorInfoOf(safe) },
			},
		});
		throw safe;
	} finally {
		await session?.close().catch(() => undefined);
		if (session) await ctx.setWorkDir?.(null);
		executor.close();
	}
}

export async function startPanelBackup(
	actor: Actor,
	input: { destinationId: string; serverId: string },
	options: { trigger: "manual" | "schedule"; policyId?: string } = {
		trigger: "manual",
	},
): Promise<{ deploymentId: string }> {
	await getDestinationRow(actor, input.destinationId);
	const server = await pickServer(actor, input.serverId);
	audit({
		actor,
		action: "backup.panel",
		targetType: "backup_destination",
		targetId: input.destinationId,
		meta: { trigger: options.trigger },
	});
	return startJob(
		{
			actor,
			serverId: server.id,
			type: "panel_backup",
			title: jobTitle("panel_backup"),
		},
		async (ctx) => {
			await performPanelBackup(
				{ actor, ...input, serverId: server.id, ...options },
				ctx,
			);
			ctx.event("self_backup.done");
			return { success: true };
		},
	);
}
