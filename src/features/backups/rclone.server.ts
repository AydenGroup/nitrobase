import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import {
	getDestinationDriver,
	type RcloneRemote,
	secretFields,
} from "#/config/backup-drivers.ts";
import { getConfig, hostPaths } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { deployments } from "#/db/schema/server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import {
	listWorkDirsCommand,
	parseWorkDirListing,
	prepareWorkDirCommand,
	removeWorkDirCommand,
	removeWorkDirsCommand,
	sweepWorkDirsCommand,
} from "#/server/services/backup/archive.ts";
import {
	rcloneCommand,
	redactor,
	remotePath,
	renderRcloneConfig,
} from "#/server/services/backup/rclone.ts";
import {
	type ExecOptions,
	type ExecResult,
	type Executor,
	shellQuote,
} from "#/server/services/executor.ts";
import { gitSweepCommand } from "#/server/services/git/commands.ts";
import { assertServerOwned } from "#/server/services/server-setup.ts";
import { decrypt } from "#/utils/crypto.ts";
import { AppError, commandError } from "#/utils/error.ts";
import type { DestinationRow } from "./schema";

/** Decrypted, driver-validated destination config (server-only: secrets). */
function destinationConfig(destination: DestinationRow) {
	const driver = getDestinationDriver(destination.type);
	if (!driver) {
		throw new AppError("DESTINATION_TYPE_UNKNOWN", { type: destination.type });
	}
	const parsed = driver.schema.safeParse(
		JSON.parse(decrypt(destination.configEncrypted)),
	);
	if (!parsed.success) {
		throw new AppError("DESTINATION_FIELD_INVALID", {
			field: String(parsed.error.issues[0]?.path[0] ?? ""),
			detail: parsed.error.issues[0]?.message ?? "",
		});
	}
	const config = parsed.data as Record<string, unknown>;
	const secrets = secretFields(driver)
		.map((name) => config[name])
		.filter((value): value is string => typeof value === "string");
	return { driver, config, secrets };
}

/** A fresh staging folder name under the managed backup work root. */
export function newWorkDir(prefix: string): string {
	return `${hostPaths().backupWork}/${prefix}-${randomBytes(6).toString("hex")}`;
}

/**
 * Remove staging folders older than any backup/restore/download could
 * run: leftovers of a panel that died mid-job (they may hold rclone.conf).
 */
export async function sweepStaleWorkDirs(
	executor: Executor,
	serverId?: string,
): Promise<string[]> {
	const config = getConfig();
	const maxJobMs = Math.max(
		config.BACKUP_JOB_TIMEOUT_MS,
		config.BACKUP_DOWNLOAD_TIMEOUT_MS,
	);
	// Folders recorded by jobs that are no longer running go regardless of age.
	const dead = serverId
		? (
				await db
					.select({ id: deployments.id, workDir: deployments.workDir })
					.from(deployments)
					.where(
						and(
							eq(deployments.serverId, serverId),
							isNotNull(deployments.workDir),
							ne(deployments.status, "running"),
						),
					)
			).filter((row) => row.workDir && !activeWorkDirs.has(row.workDir))
		: [];
	const result = await executor.exec(
		sweepWorkDirsCommand(
			hostPaths().backupWork,
			maxJobMs / 60_000 + 1,
			dead.map((row) => row.workDir as string),
		),
	);
	if (result.exitCode !== 0) {
		throw commandError("WORKDIR_SWEEP_FAILED", result.stderr);
	}
	// Git build/check folders (may hold a deploy key or build secrets).
	const roots = { apps: hostPaths().apps, gitInspect: hostPaths().gitInspect };
	const gitMinutes =
		(config.BUILD_MAX_TIMEOUT_SECONDS * 1000 +
			config.GIT_CLONE_TIMEOUT_MS * 2 +
			config.GIT_INSPECT_TIMEOUT_MS) /
			60_000 +
		1;
	const git = await executor.exec(
		gitSweepCommand(
			roots,
			gitMinutes,
			dead.map((row) => row.workDir as string),
		),
	);
	if (git.exitCode !== 0) {
		throw commandError("GIT_SWEEP_FAILED", git.stderr);
	}
	if (dead.length) {
		await db
			.update(deployments)
			.set({ workDir: null })
			.where(
				inArray(
					deployments.id,
					dead.map((row) => row.id),
				),
			);
	}
	return `${result.stdout}\n${git.stdout}`
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !activeWorkDirs.has(line));
}

export interface WorkDirView {
	path: string;
	modifiedAt: Date;
	sizeKb: number;
	/** Used by a job running now: never removed. */
	inUse: boolean;
}

/** Staging folders in use: open in this process or recorded by a running job. */
async function inUseWorkDirs(serverId: string): Promise<Set<string>> {
	const running = await db
		.select({ workDir: deployments.workDir })
		.from(deployments)
		.where(
			and(
				eq(deployments.serverId, serverId),
				isNotNull(deployments.workDir),
				eq(deployments.status, "running"),
			),
		);
	return new Set([
		...activeWorkDirs,
		...running.map((row) => row.workDir as string),
	]);
}

/** Every staging folder on the server, any age ("Clean up leftovers now"). */
export async function listWorkDirs(
	executor: Executor,
	serverId: string,
): Promise<WorkDirView[]> {
	const root = hostPaths().backupWork;
	const result = await executor.exec(listWorkDirsCommand(root));
	if (result.exitCode !== 0) {
		throw commandError("WORKDIR_LIST_FAILED", result.stderr);
	}
	const inUse = await inUseWorkDirs(serverId);
	return parseWorkDirListing(result.stdout, root).map((entry) => ({
		...entry,
		inUse: inUse.has(entry.path),
	}));
}

/**
 * Remove chosen staging folders (manual cleanup, after confirmation). Folders
 * in use are skipped, checked again now. Returns the removed paths.
 */
export async function removeWorkDirs(
	executor: Executor,
	serverId: string,
	paths: string[],
): Promise<{ removed: string[]; skipped: string[] }> {
	const root = hostPaths().backupWork;
	const inUse = await inUseWorkDirs(serverId);
	const skipped = paths.filter((path) => inUse.has(path));
	const chosen = paths.filter((path) => !inUse.has(path));
	if (chosen.length === 0) return { removed: [], skipped };
	const result = await executor.exec(removeWorkDirsCommand(root, chosen));
	if (result.exitCode !== 0) {
		throw commandError("WORKDIR_REMOVE_FAILED", result.stderr);
	}
	if (chosen.length) {
		// Forget them on finished jobs (recovery would look for them).
		await db
			.update(deployments)
			.set({ workDir: null })
			.where(
				and(
					inArray(deployments.workDir, chosen),
					ne(deployments.status, "running"),
				),
			);
	}
	return {
		removed: result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
		skipped,
	};
}

/** Staging folders of sessions open in this process (never swept). */
const globalWorkDirs = globalThis as typeof globalThis & {
	__nitrobaseActiveWorkDirs?: Set<string>;
};
globalWorkDirs.__nitrobaseActiveWorkDirs ??= new Set();
const activeWorkDirs = globalWorkDirs.__nitrobaseActiveWorkDirs;

export interface RcloneSession {
	workDir: string;
	remote: RcloneRemote;
	/** Scrubs destination secrets from text. */
	redact: (text: string) => string;
	remotePath: (key: string) => string;
	/** Run rclone with `args` (`/work` = the staging folder). */
	run: (
		args: string[],
		options?: ExecOptions & { workReadOnly?: boolean },
	) => Promise<ExecResult>;
	/** Remove the staging folder (and the rclone.conf in it). */
	close: () => Promise<void>;
}

/**
 * Prepare a staging folder on the server with a 0600 rclone.conf for the
 * destination. Always `close()` (it removes the credentials file).
 */
export async function openRclone(
	executor: Executor,
	destination: DestinationRow,
	workDir: string,
): Promise<RcloneSession> {
	const appConfig = getConfig();
	const { driver, config, secrets } = destinationConfig(destination);
	const remote = driver.toRclone(config as never, {
		localRoot: appConfig.BACKUP_LOCAL_ROOT,
	});
	const redact = redactor(secrets);
	// The staging folder is under the managed root: never on a server of
	// another instance.
	await assertServerOwned(executor, await requireInstanceId());
	await sweepStaleWorkDirs(executor);
	activeWorkDirs.add(workDir);
	const prepared = await executor.exec(prepareWorkDirCommand(workDir));
	if (prepared.exitCode !== 0) {
		activeWorkDirs.delete(workDir);
		throw new AppError("FOLDER_CREATE_FAILED", {
			path: workDir,
			detail: prepared.stderr,
		});
	}
	const confPath = `${workDir}/rclone.conf`;
	await executor.upload(renderRcloneConfig(remote), confPath, "0600");
	if (remote.mount) {
		const target = remote.base.replace(
			remote.mount.container,
			remote.mount.host,
		);
		const made = await executor.exec(
			`umask 077 && mkdir -p -- ${shellQuote(target)}`,
		);
		if (made.exitCode !== 0) {
			throw new AppError("FOLDER_CREATE_FAILED", {
				path: target,
				detail: made.stderr,
			});
		}
	}
	return {
		workDir,
		remote,
		redact,
		remotePath: (key) => remotePath(remote, key),
		run: async (args, options = {}) => {
			const { workReadOnly, ...execOptions } = options;
			const result = await executor.exec(
				rcloneCommand({
					image: appConfig.RCLONE_IMAGE,
					confPath,
					remote,
					workDir,
					workReadOnly,
					args,
				}),
				{
					timeoutMs: appConfig.BACKUP_JOB_TIMEOUT_MS,
					...execOptions,
				},
			);
			return {
				...result,
				stderr: redact(result.stderr),
				stdout: execOptions.discardOutput ? "" : redact(result.stdout),
			};
		},
		close: async () => {
			try {
				await executor.exec(removeWorkDirCommand(workDir));
			} finally {
				activeWorkDirs.delete(workDir);
			}
		},
	};
}
