import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { SELF_BACKUP_LAYOUT } from "#/config/self-backup.ts";
import { getConfig } from "#/config/server.ts";
import { APP_ID } from "#/config/shared.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { db } from "#/db/index.ts";
import { reencryptAll } from "#/db/reencrypt.ts";
import { REGISTRATION_LOCK_KEY } from "#/features/auth/auth.server.ts";
import { pgEnvFromUrl } from "#/features/backups/self-backup.server.ts";
import { stopMonitoring } from "#/features/monitoring/service.server.ts";
import { checkInstanceIdentity } from "#/features/settings/instance-identity.server.ts";
import { clipEnd } from "#/libs/format.ts";
import { audit } from "#/server/services/audit.ts";
import {
	restorePostamble,
	restorePreamble,
} from "#/server/services/backup/dump-check.ts";
import {
	PanelArchiveError,
	readPanelArchive,
	receiveToFile,
	writeRestoreScript,
} from "#/server/services/backup/panel-archive.ts";
import { pgIdent } from "#/server/services/databases/sql.ts";
import { setInstancePaused } from "#/server/services/instance-state.ts";
import { stopScheduler } from "#/server/services/scheduler.ts";
import { requireSecret } from "#/utils/env.ts";
import { AppError, coded, internalError } from "#/utils/error.ts";
import type { FirstRunRestoreResult } from "./schema";

/**
 * First-run "Restore Nitrobase from a self-backup" (disaster recovery from
 * the panel, instead of the README's psql steps). Only while no account
 * exists (checked under the first sign-up's advisory lock), with the
 * installer's setup token, one at a time:
 *
 *   1. the upload is streamed to a temp file with a byte cap, hashed on the
 *      way; that sha256 must equal the checksum the owner noted (CBC has
 *      no MAC),
 *   2. decrypt + gunzip + untar as streams to disk; check the manifest,
 *   3. check the dump statement by statement (dump-check.ts) while writing
 *      the script psql loads,
 *   4. load it in one transaction AS A NOSUPERUSER ROLE that owns the
 *      recreated schemas (COPY … PROGRAM, untrusted languages, ALTER SYSTEM
 *      or roles fail whatever the dump says), then hand ownership back,
 *   5. run this version's migrations, re-encrypt stored secrets from the
 *      old key, drop the backup's sessions,
 *   6. pause: the restored database names the old instance, so the
 *      split-brain guard keeps jobs, schedules and monitoring off until an
 *      instance admin resumes.
 */

const globalRestore = globalThis as typeof globalThis & {
	__nitrobaseFirstRunRestore?: boolean;
};

function archiveError(error: PanelArchiveError): AppError {
	const problem = error.problem;
	switch (problem.code) {
		case "checksum":
			return new AppError("RESTORE_CHECKSUM_MISMATCH");
		case "decrypt":
			return new AppError("RESTORE_DECRYPT_FAILED");
		case "too_large":
			return new AppError("RESTORE_ARCHIVE_INVALID", {
				reason: { $error: coded("ARCHIVE_TOO_LARGE") },
			});
		case "archive":
			return new AppError("RESTORE_ARCHIVE_INVALID", {
				reason: { $error: problem.reason },
			});
		case "dump":
			return new AppError("RESTORE_DUMP_REFUSED", {
				reason: { $error: problem.reason },
			});
	}
}

/**
 * psql over the script file, one transaction, stop at the first error,
 * logged in AS the restricted restore role (password only in the child's
 * environment, never in argv): nothing in the dump can return to the
 * panel's superuser login (SET ROLE / set_config('role') check the session
 * user, which is the restricted role itself).
 */
async function runPsql(
	file: string,
	login: { user: string; password: string },
): Promise<void> {
	const config = getConfig();
	const url = process.env.DATABASE_URL;
	if (!url) throw internalError("DATABASE_URL is not set");
	const [command, ...args] = config.FIRST_RUN_RESTORE_PSQL.split(/\s+/);
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			command,
			[
				...args,
				"-X",
				"-q",
				"-v",
				"ON_ERROR_STOP=1",
				"--single-transaction",
				"-f",
				file,
			],
			{
				env: {
					...process.env,
					...pgEnvFromUrl(url),
					PGUSER: login.user,
					PGPASSWORD: login.password,
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		let stderr = "";
		const timer = setTimeout(
			() => child.kill("SIGKILL"),
			config.FIRST_RUN_RESTORE_TIMEOUT_MS,
		);
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = clipEnd(
				`${stderr}${chunk.toString()}`,
				TEXT_LIMITS.processErrorTail,
			);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else
				reject(
					new AppError("RESTORE_FAILED", {
						detail:
							stderr.trim().split("\n").slice(-3).join(" ") || `exit ${code}`,
					}),
				);
		});
	});
}

/**
 * The NOSUPERUSER role the dump runs as: created when missing, attributes
 * forced every time (a pre-existing role of that name must not keep more
 * rights), granted to the panel's login (REASSIGN OWNED afterwards). It
 * stays NOLOGIN except during the load (`openRestoreLogin`).
 */
async function ensureRestoreRole(role: string): Promise<string> {
	const ident = pgIdent(role);
	try {
		await db.execute(
			sql.raw(
				`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${ident} NOLOGIN; END IF; END $$;`,
			),
		);
		await db.execute(
			sql.raw(
				`ALTER ROLE ${ident} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
			),
		);
		await db.execute(sql.raw(`GRANT ${ident} TO CURRENT_USER`));
	} catch (error) {
		throw new AppError("RESTORE_ROLE_FAILED", {
			role,
			detail: error instanceof Error ? error.message : String(error),
		});
	}
	const check = await db.execute<{ rolsuper: boolean }>(
		sql`select rolsuper from pg_roles where rolname = ${role}`,
	);
	if (check.rows[0]?.rolsuper !== false) {
		throw new AppError("RESTORE_ROLE_NOT_PLAIN", { role });
	}
	return ident;
}

/** Superuser step: LOGIN with a fresh random password for the load only. */
async function openRestoreLogin(ident: string): Promise<string> {
	const password = randomBytes(32).toString("hex");
	await db.execute(sql.raw(`ALTER ROLE ${ident} LOGIN PASSWORD '${password}'`));
	return password;
}

/** Superuser step: no login, no password, no session left for the role. */
async function closeRestoreLogin(ident: string, role: string): Promise<void> {
	await db.execute(sql.raw(`ALTER ROLE ${ident} NOLOGIN PASSWORD NULL`));
	await db.execute(
		sql`select pg_terminate_backend(pid) from pg_stat_activity where usename = ${role}`,
	);
}

/** Receive the upload into a fresh temp folder (removed by `restore…`). */
export async function receiveUpload(
	body: AsyncIterable<Uint8Array>,
): Promise<{ workDir: string; file: string; sha256: string }> {
	const workDir = await mkdtemp(path.join(tmpdir(), `${APP_ID}-restore-`));
	const file = path.join(workDir, "upload.enc");
	try {
		const received = await receiveToFile(
			body,
			file,
			getConfig().FIRST_RUN_RESTORE_MAX_BYTES,
		);
		return { workDir, file, sha256: received.sha256 };
	} catch (error) {
		await rm(workDir, { recursive: true, force: true });
		throw error;
	}
}

/** Claim the single restore slot; false when taken. */
export function claimRestoreSlot(): boolean {
	if (globalRestore.__nitrobaseFirstRunRestore) return false;
	globalRestore.__nitrobaseFirstRunRestore = true;
	return true;
}

export function releaseRestoreSlot(): void {
	globalRestore.__nitrobaseFirstRunRestore = false;
}

export async function restoreFromSelfBackup(input: {
	workDir: string;
	file: string;
	sha256: string;
	expectedSha256: string;
	key: string;
}): Promise<FirstRunRestoreResult> {
	const config = getConfig();
	const dumpPath = path.join(input.workDir, SELF_BACKUP_LAYOUT.dump);
	const scriptPath = path.join(input.workDir, "load.sql");
	let manifest: Awaited<ReturnType<typeof readPanelArchive>>["manifest"];
	const client = await db.$client.connect();
	try {
		try {
			({ manifest } = await readPanelArchive({
				file: input.file,
				sha256: input.sha256,
				expectedSha256: input.expectedSha256,
				key: input.key,
				iterations: config.SELF_BACKUP_PBKDF2_ITERATIONS,
				maxBytes: config.FIRST_RUN_RESTORE_MAX_EXPANDED_BYTES,
				dumpPath,
			}));
			await rm(input.file, { force: true });
			await writeRestoreScript({
				dumpPath,
				scriptPath,
				preamble: "",
				postamble: "",
				maxStatementBytes: config.FIRST_RUN_RESTORE_MAX_STATEMENT_BYTES,
			});
			await rm(dumpPath, { force: true });
		} catch (error) {
			if (error instanceof PanelArchiveError) throw archiveError(error);
			throw error;
		}

		await client.query("select pg_advisory_lock($1)", [REGISTRATION_LOCK_KEY]);
		const existing = await client.query<{ n: number }>(
			"select count(*)::int as n from users",
		);
		if ((existing.rows[0]?.n ?? 0) > 0) throw new AppError("RESTORE_NOT_EMPTY");

		// Nothing in the background touches the database while it is replaced.
		stopScheduler();
		await stopMonitoring().catch(() => undefined);

		// Superuser: empty the database, schemas owned by the restricted role.
		const role = config.FIRST_RUN_RESTORE_ROLE;
		const ident = await ensureRestoreRole(role);
		await client.query("begin");
		await client.query(restorePreamble(ident));
		await client.query("commit");
		const password = await openRestoreLogin(ident);
		try {
			await runPsql(scriptPath, { user: role, password });
		} catch (error) {
			// Back to a fresh, empty installation (no account existed).
			await closeRestoreLogin(ident, role).catch(() => undefined);
			await client.query(restorePreamble("CURRENT_USER"));
			await client.query(restorePostamble(ident)).catch(() => undefined);
			await migrate(db, {
				migrationsFolder: path.resolve(process.cwd(), "drizzle"),
			});
			throw error;
		} finally {
			await closeRestoreLogin(ident, role).catch(() => undefined);
			await rm(scriptPath, { force: true });
		}
		// Superuser: everything back to the panel's own login.
		await client.query(restorePostamble(ident));

		// The backup may come from an older Nitrobase.
		await migrate(db, {
			migrationsFolder: path.resolve(process.cwd(), "drizzle"),
		});

		const current = requireSecret("ENCRYPTION_KEY");
		const keyChanged = input.key !== current;
		const reencrypted = keyChanged
			? await reencryptAll(db, {
					oldSecret: input.key,
					newSecret: current,
				})
			: 0;
		// Sessions of the old installation mean nothing here.
		await db.execute(sql`delete from sessions`);

		// The restored database names the old installation: paused until an
		// instance admin resumes here. A backup older than the identity
		// guard has no id: give it one that cannot match this machine.
		const identity = await db.execute<{ n: number }>(
			sql`select count(*)::int as n from settings where key = 'instance.identity'`,
		);
		if ((identity.rows[0]?.n ?? 0) === 0) {
			await db.execute(
				sql`insert into settings (key, value, updated_at) values ('instance.identity', ${JSON.stringify({ plain: `restored-${randomUUID()}` })}::jsonb, now())`,
			);
		}
		const paused = await checkInstanceIdentity();
		if (!paused) setInstancePaused("mismatch");

		const accounts = await client.query<{ n: number }>(
			"select count(*)::int as n from users",
		);
		audit({
			action: "settings.instance_restore",
			meta: {
				backupCreatedAt: manifest.createdAt,
				backupVersion: manifest.version,
				keyChanged,
			},
		});
		return {
			accounts: accounts.rows[0]?.n ?? 0,
			reencrypted,
			keyChanged,
			backupCreatedAt: manifest.createdAt,
		};
	} finally {
		await client
			.query("select pg_advisory_unlock($1)", [REGISTRATION_LOCK_KEY])
			.catch(() => undefined);
		client.release();
		await rm(input.workDir, { recursive: true, force: true });
	}
}
