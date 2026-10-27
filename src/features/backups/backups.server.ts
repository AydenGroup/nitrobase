import { and, desc, eq, inArray, ne, or, type SQL } from "drizzle-orm";
import { DATABASE_TEMPLATE_ID } from "#/config/database-engines.ts";
import { databaseRowRequirements } from "#/config/permissions.ts";
import { getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import {
	backupDestinations,
	backupPolicies,
	backups,
} from "#/db/schema/backups.ts";
import { type CommandFailure, run } from "#/features/apps/app-jobs.server.ts";
import {
	appInputs,
	appLocation,
	appOverrides,
	containerName,
	deployedServices,
	getAppManifest,
	getAppServer,
	listAppDomains,
	readCustomSpec,
	readEnvValues,
	readServiceEnv,
} from "#/features/apps/apps.server.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess, can } from "#/features/auth/access.ts";
import type { JobLogger } from "#/features/deployments/deployments.server.ts";
import {
	type JobContext,
	redactingContext,
	registerJobRecovery,
} from "#/features/deployments/deployments.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import {
	backupDatabaseService,
	backupStopPhases,
	type CustomComposeSpec,
} from "#/features/templates/schema.ts";
import { clip } from "#/libs/format.ts";
import { databaseStrategyFor } from "#/plugins/server.ts";
import {
	type AppLocation,
	appContainerCheckScript,
	bindSourcesCheckScript,
	composeConfigCommand,
	composeServiceCommand,
	composeStartServicesCommand,
	composeStatusCommand,
	parseServiceStatus,
} from "#/server/services/apps/commands.ts";
import { composeDependsOn } from "#/server/services/apps/dependents.ts";
import { audit } from "#/server/services/audit.ts";
import {
	archiveSourceCommand,
	buildManifest,
	COMPOSE_FILE,
	checksumsCommand,
	ENV_FILE,
	ensureToolsImageCommand,
	fileDigestCommand,
	hookCommand,
	MANIFEST_FILE,
	packCommand,
	parseChecksums,
	parseFileDigest,
	parseSizes,
	sizesCommand,
} from "#/server/services/backup/archive.ts";
import { rcloneFailure } from "#/server/services/backup/rclone.ts";
import { selectExpired } from "#/server/services/backup/retention.ts";
import {
	errorColumns,
	errorInfoOf,
	redactError,
} from "#/server/services/error-info.ts";
import { emitEvent } from "#/server/services/events/bus.ts";
import { type Executor, shellQuote } from "#/server/services/executor.ts";
import { assertServerOwned } from "#/server/services/server-setup.ts";
import { encrypt } from "#/utils/crypto.ts";
import { AppError } from "#/utils/error.ts";
import { getDestinationRow, pickServer } from "./destinations.server";
import { newWorkDir, openRclone, type RcloneSession } from "./rclone.server";
import type { BackupDTO, BackupRow, DestinationRow } from "./schema";

/** Decrypted content of `env.enc` (instance key). */
export interface EnvPayload {
	values: Record<string, string>;
	overrides: Record<string, string>;
	serviceEnv: Record<string, Record<string, string>>;
	publishedPorts: Record<string, number>;
	/** Primary domain at backup time (a clone drops overrides naming it). */
	primaryHost: string | null;
	/** Custom-compose apps: their compose, env and choices. */
	custom?: CustomComposeSpec;
}

/** Compose volume key -> real (project-scoped) volume name. */
export function composeVolumeNames(model: unknown): Record<string, string> {
	const volumes = (model as { volumes?: Record<string, { name?: string }> })
		?.volumes;
	return Object.fromEntries(
		Object.entries(volumes ?? {})
			.filter(([, volume]) => typeof volume?.name === "string")
			.map(([key, volume]) => [key, volume.name as string]),
	);
}

/**
 * Services of `services` with a running (or restarting) container: the
 * only ones a backup stops, so it starts nothing that wasn't running
 * (owner-stopped services, finished one-shots).
 */
export async function runningServices(
	executor: Executor,
	ctx: JobContext,
	location: AppLocation,
	services: readonly string[],
): Promise<string[]> {
	const up = new Set(
		parseServiceStatus(
			await run(
				executor,
				ctx,
				composeStatusCommand(location),
				"COMPOSE_PS_FAILED",
				{ quiet: true },
			),
		)
			.filter((item) => item.state === "running" || item.state === "restarting")
			.map((item) => item.service),
	);
	return services.filter((service) => up.has(service));
}

export async function resolvedComposeModel(
	executor: Executor,
	app: AppRow,
	ctx: JobContext,
): Promise<unknown> {
	const output = await run(
		executor,
		ctx,
		composeConfigCommand(appLocation(app)),
		"COMPOSE_CONFIG_FAILED",
		{ quiet: true },
	);
	return JSON.parse(output);
}

function backupKey(app: Pick<AppRow, "folder">, id: string, at: Date) {
	const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z");
	return `${app.folder}/${stamp}-${id.slice(0, 8)}.tar.zst`;
}

export function toolsImage() {
	const config = getConfig();
	return {
		image: config.BACKUP_TOOLS_IMAGE,
		baseImage: config.BACKUP_TOOLS_BASE_IMAGE,
	};
}

/**
 * Build a full backup of `app` on its server and upload it. Runs inside a
 * job that already holds the server lock (backup job, or "back up first"
 * before an update/delete/rotation).
 */
export async function performAppBackup(
	input: {
		appId: string;
		actor: Actor;
		destination: DestinationRow;
		trigger: "manual" | "schedule";
		policyId?: string;
		deploymentId: string;
		/**
		 * Leave the services the backup stopped stopped (a move freezes the
		 * source from here on; the job records them, so recovery restarts
		 * them if the job dies).
		 */
		keepStopped?: boolean;
	},
	ctx: JobContext,
): Promise<BackupRow> {
	const config = getConfig();
	const [app] = await db
		.select()
		.from(apps)
		.where(eq(apps.id, input.appId))
		.limit(1);
	if (!app) throw new AppError("APP_NOT_FOUND");
	const services = deployedServices(app);
	if (services.length === 0) throw new AppError("APP_NOT_DEPLOYED");
	const manifest = await getAppManifest(app);
	const plan = manifest.backup;
	const databaseService = backupDatabaseService(plan);
	const strategy =
		databaseService && services.includes(databaseService)
			? databaseStrategyFor(app.templateId, manifest)
			: null;
	const startedAt = new Date();
	const [row] = await db
		.insert(backups)
		.values({
			teamId: app.teamId,
			userId: input.actor.userId,
			appId: app.id,
			serverId: app.serverId,
			destinationId: input.destination.id,
			policyId: input.policyId ?? null,
			deploymentId: input.deploymentId,
			kind: "full",
			status: "running",
			trigger: input.trigger,
			appName: app.name,
			templateId: app.templateId,
			folder: app.folder,
			version: app.version,
			commitSha: app.commitSha,
			customSpecEncrypted: app.customSpecEncrypted,
		})
		.returning();

	const location = appLocation(app);
	const executor = await getExecutor(await getAppServer(app));
	let session: RcloneSession | null = null;
	const stopped: string[] = [];
	ctx.setCancelState?.("backup_not_stored");
	try {
		const workDir = newWorkDir("backup");
		// Recorded first: a crash from here on leaves a folder to remove.
		await ctx.setWorkDir?.(workDir);
		session = await openRclone(executor, input.destination, workDir);
		const work = session.workDir;
		const redact = session.redact;
		const log = redactingContext(ctx, redact);
		const exec = (command: string, failure: CommandFailure) =>
			run(executor, log, command, failure, {
				quiet: true,
				timeoutMs: config.BACKUP_JOB_TIMEOUT_MS,
			});
		const tools = toolsImage();

		log.event("backup.starting", {
			app: app.name,
			template: app.templateId,
			version: app.version,
			destination: input.destination.name,
		});
		await exec(ensureToolsImageCommand(tools), "BACKUP_TOOLS_FAILED");
		await assertServerOwned(executor, await requireInstanceId());
		// Hooks and dumps exec into the app's containers: they must be its own.
		await exec(
			appContainerCheckScript(
				services.map((service) => containerName(app.folder, service)),
				app.id,
			),
			"RESTORE_FOREIGN_CONTAINER",
		);
		const model = await resolvedComposeModel(executor, app, ctx);
		const volumeNames = composeVolumeNames(model);

		for (const hook of plan.hooks.filter((item) => item.when === "pre")) {
			log.event("backup.pre_hook", { service: hook.service });
			await exec(
				hookCommand(containerName(app.folder, hook.service), hook.command),
				"BACKUP_PRE_HOOK_FAILED",
			);
		}

		const stopServices = async (list: string[]) => {
			for (const service of list) {
				// Recorded before stopping: recovery restarts it if we die, and
				// a failed stop (maybe half done) is started again too.
				await ctx.servicesStopped?.([service]);
				stopped.push(service);
				await exec(
					composeServiceCommand(location, "stop", service),
					(detail) => new AppError("SERVICE_STOP_FAILED", { service, detail }),
				);
			}
		};
		const dumpService = strategy && databaseService ? databaseService : null;
		// What runs is read from the server (compose ps), never from
		// `apps.status`: an app left in `error` by a failed job may still run
		// every container, and copying its live volumes corrupts the archive
		// (BUG-020). A failed status read fails the backup (COMPOSE_PS_FAILED).
		const phases =
			plan.stop !== false
				? backupStopPhases(
						plan,
						await runningServices(executor, log, location, services),
						dumpService,
						composeDependsOn(model),
					)
				: { beforeDump: [], afterDump: [] };
		let remaining = phases.beforeDump;
		if (strategy && dumpService) {
			// Writers stop before the dump (the database keeps running for
			// it): a write they acknowledged after the dump began would be in
			// the copied volumes but not in the dump (OneDev #14).
			if (phases.beforeDump.length) {
				log.event("backup.stopping_before_dump", {
					services: { $list: phases.beforeDump },
					database: dumpService,
				});
				await stopServices(phases.beforeDump);
			}
			log.event("backup.dumping", { strategy: strategy.id });
			await exec(
				`${strategy.dumpCommand(containerName(app.folder, dumpService))} > ${shellQuote(`${work}/members/db/${strategy.file}`)}`,
				"BACKUP_DUMP_FAILED",
			);
			remaining = phases.afterDump;
		}
		if (remaining.length) {
			log.event("backup.stopping", { services: { $list: remaining } });
			await stopServices(remaining);
		}

		const sources: Record<string, string> = {};
		const absolute = plan.paths.map((item) => `${location.appRoot}/${item}`);
		if (absolute.length) {
			// A container may have replaced a folder with a symlink: refuse.
			await exec(
				bindSourcesCheckScript(location, absolute),
				"BACKUP_UNSAFE_PATH",
			);
		}
		for (const [index, item] of plan.paths.entries()) {
			log.event("backup.archiving_path", { path: item });
			const member = `files/${index}.tar`;
			await exec(
				archiveSourceCommand(
					tools.image,
					absolute[index],
					`${work}/members/${member}`,
				),
				(detail) =>
					new AppError("BACKUP_ARCHIVE_PATH_FAILED", { path: item, detail }),
			);
			sources[member] = item;
		}
		for (const [index, volume] of plan.volumes.entries()) {
			const name = volumeNames[volume];
			if (!name) {
				// An incomplete archive would restore without this data.
				throw new AppError("BACKUP_VOLUME_MISSING", { volume });
			}
			log.event("backup.archiving_volume", { volume });
			const member = `volumes/${index}.tar`;
			await exec(
				archiveSourceCommand(tools.image, name, `${work}/members/${member}`),
				(detail) =>
					new AppError("BACKUP_ARCHIVE_VOLUME_FAILED", { volume, detail }),
			);
			sources[member] = volume;
		}

		if (stopped.length && input.keepStopped) {
			// Kept in `stopped` until the archive is stored: a failure below
			// still starts them again (finally).
			log.event("backup.leaving_stopped", { services: { $list: stopped } });
		} else if (stopped.length) {
			// Exactly what this job stopped, dependencies first: services
			// the owner stopped and finished one-shots stay as they were.
			const restart = [...stopped].reverse();
			log.event("backup.restarting", { services: { $list: restart } });
			await exec(
				composeStartServicesCommand(location, restart),
				"APP_START_FAILED",
			);
			stopped.length = 0;
			await ctx.servicesStarted?.(restart);
		}
		for (const hook of plan.hooks.filter((item) => item.when === "post")) {
			log.event("backup.post_hook", { service: hook.service });
			await exec(
				hookCommand(containerName(app.folder, hook.service), hook.command),
				"BACKUP_POST_HOOK_FAILED",
			);
		}

		const env: EnvPayload = {
			values: readEnvValues(app),
			overrides: appOverrides(app),
			serviceEnv: readServiceEnv(app),
			publishedPorts: appInputs(app).publishedPorts ?? {},
			primaryHost:
				(await listAppDomains(app.id)).find((domain) => domain.primary)?.host ??
				null,
			custom: readCustomSpec(app) ?? undefined,
		};
		await executor.upload(
			encrypt(JSON.stringify(env)),
			`${work}/members/${ENV_FILE}`,
			"0600",
		);
		await executor.upload(
			app.composeDeployed ?? "",
			`${work}/members/${COMPOSE_FILE}`,
			"0600",
		);

		const checksums = parseChecksums(
			await exec(
				checksumsCommand(`${work}/members`),
				"ARCHIVE_CHECKSUM_FAILED",
			),
		);
		const sizes = parseSizes(
			await exec(sizesCommand(`${work}/members`), "BACKUP_SIZE_FAILED"),
		);
		const archiveManifest = buildManifest({
			createdAt: startedAt,
			app: {
				id: app.id,
				name: app.name,
				templateId: app.templateId,
				folder: app.folder,
			},
			template: { version: app.version, commitSha: app.commitSha ?? "" },
			database:
				strategy && databaseService
					? { strategy: strategy.id, service: databaseService }
					: null,
			sources,
			checksums,
			sizes,
		});
		await executor.upload(
			JSON.stringify(archiveManifest, null, 2),
			`${work}/members/${MANIFEST_FILE}`,
			"0600",
		);

		log.event("backup.compressing");
		await exec(
			packCommand(tools.image, work, config.BACKUP_ZSTD_LEVEL),
			"BACKUP_PACK_FAILED",
		);
		const digest = parseFileDigest(
			await exec(
				fileDigestCommand(`${work}/archive.tar.zst`),
				"ARCHIVE_READ_FAILED",
			),
		);
		const key = backupKey(app, row.id, startedAt);
		log.event("backup.uploading", { size: { $bytes: digest.size } });
		const upload = await session.run(
			["copyto", "/work/archive.tar.zst", session.remotePath(key)],
			{
				workReadOnly: true,
				signal: ctx.signal,
			},
		);
		if (upload.exitCode !== 0) {
			throw rcloneFailure("upload", redact(upload.stderr), log);
		}

		const [done] = await db
			.update(backups)
			.set({
				status: "success",
				path: key,
				sizeBytes: digest.size,
				checksum: digest.sha256,
				durationMs: Date.now() - startedAt.getTime(),
				finishedAt: new Date(),
			})
			.where(eq(backups.id, row.id))
			.returning();
		log.event("backup.stored", {
			key,
			sha256: digest.sha256.slice(0, 16),
		});
		// Moving: the services stay stopped now that the copy is safe.
		if (input.keepStopped) stopped.length = 0;
		const retentionPolicy =
			input.policyId ??
			(await manualRetentionPolicy(app.id, input.destination.id));
		if (retentionPolicy) await applyRetention(retentionPolicy, session, log);
		return done;
	} catch (error) {
		const safe = session ? redactError(error, session.redact) : error;
		const failure = errorInfoOf(safe);
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
			teamId: app.teamId,
			userId: input.actor.userId,
			subject: row.id,
			serverId: app.serverId,
			appId: app.id,
			params: {
				destination: input.destination.name,
				error: { $error: failure },
			},
		});
		throw safe;
	} finally {
		if (stopped.length) {
			const restart = [...stopped].reverse();
			const started = await executor
				.exec(composeStartServicesCommand(location, restart))
				.catch(() => null);
			// Otherwise the job runner's recovery retries them.
			if (started?.exitCode === 0) await ctx.servicesStarted?.(restart);
		}
		await session?.close().catch(() => undefined);
		if (session) await ctx.setWorkDir?.(null);
		executor.close();
	}
}

/** The app's policy when it also prunes manual backups on `destinationId`. */
async function manualRetentionPolicy(
	appId: string,
	destinationId: string,
): Promise<string | null> {
	const [policy] = await db
		.select({ id: backupPolicies.id })
		.from(backupPolicies)
		.where(
			and(
				eq(backupPolicies.appId, appId),
				eq(backupPolicies.destinationId, destinationId),
				eq(backupPolicies.includeManual, true),
			),
		)
		.limit(1);
	return policy?.id ?? null;
}

/**
 * After deleting an archive, remove its per-app folder when it is now
 * empty (`rclone rmdir` refuses non-empty folders; object stores have no
 * real folders, so it is a no-op there). Best effort.
 */
async function removeEmptyParent(
	session: RcloneSession,
	archivePath: string,
): Promise<void> {
	const parent = archivePath.split("/").slice(0, -1).join("/");
	if (!parent) return;
	await session.run(["rmdir", session.remotePath(parent)]).catch(() => null);
}

/** Delete archives (and rows) the policy's retention no longer keeps. */
export async function applyRetention(
	policyId: string,
	session: RcloneSession,
	log: JobLogger,
): Promise<void> {
	const [policy] = await db
		.select()
		.from(backupPolicies)
		.where(eq(backupPolicies.id, policyId))
		.limit(1);
	if (!policy) return;
	// Scheduled runs of the policy; manual runs of the app on the same
	// destination only when the policy opts in.
	const owned =
		policy.includeManual && policy.appId
			? or(
					eq(backups.policyId, policy.id),
					and(eq(backups.appId, policy.appId), eq(backups.trigger, "manual")),
				)
			: eq(backups.policyId, policy.id);
	const rows = await db
		.select()
		.from(backups)
		.where(and(owned, eq(backups.destinationId, policy.destinationId)));
	const expired = selectExpired(rows, policy, new Date());
	for (const backup of expired) {
		if (backup.path) {
			const removed = await session.run([
				"deletefile",
				session.remotePath(backup.path),
			]);
			if (removed.exitCode !== 0) {
				log.event("backup.retention_failed", {
					path: backup.path,
					detail: removed.stderr,
				});
				continue;
			}
		}
		await db.delete(backups).where(eq(backups.id, backup.id));
		log.event("backup.retention_removed", { path: backup.path ?? "" });
	}
}

// ---------------------------------------------------------------------------
// Queries

const backupColumns = {
	id: backups.id,
	appId: backups.appId,
	serverId: backups.serverId,
	destinationId: backups.destinationId,
	policyId: backups.policyId,
	deploymentId: backups.deploymentId,
	kind: backups.kind,
	status: backups.status,
	trigger: backups.trigger,
	appName: backups.appName,
	templateId: backups.templateId,
	folder: backups.folder,
	version: backups.version,
	commitSha: backups.commitSha,
	path: backups.path,
	sizeBytes: backups.sizeBytes,
	checksum: backups.checksum,
	durationMs: backups.durationMs,
	error: backups.error,
	errorCode: backups.errorCode,
	errorParams: backups.errorParams,
	createdAt: backups.createdAt,
	finishedAt: backups.finishedAt,
	verifiedAt: backups.verifiedAt,
	destinationName: backupDestinations.name,
} as const;

export async function listBackups(
	actor: Actor,
	filters: {
		appId?: string;
		destinationId?: string;
		status?: BackupRow["status"];
		kind?: BackupRow["kind"];
	},
): Promise<BackupDTO[]> {
	const where: SQL[] = [eq(backups.teamId, actor.teamId)];
	// Nitrobase self-backups hold every team's data: instance admins only.
	if (!can(actor, "instance.manage")) where.push(ne(backups.kind, "panel"));
	if (filters.appId) where.push(eq(backups.appId, filters.appId));
	if (filters.destinationId)
		where.push(eq(backups.destinationId, filters.destinationId));
	if (filters.status) where.push(eq(backups.status, filters.status));
	if (filters.kind) where.push(eq(backups.kind, filters.kind));
	return db
		.select(backupColumns)
		.from(backups)
		.leftJoin(
			backupDestinations,
			eq(backupDestinations.id, backups.destinationId),
		)
		.where(and(...where))
		.orderBy(desc(backups.createdAt))
		.limit(500);
}

export async function getBackupRow(
	actor: Actor,
	id: string,
): Promise<BackupRow> {
	const [row] = await db
		.select()
		.from(backups)
		.where(eq(backups.id, id))
		.limit(1);
	const backup = assertCanAccess(
		actor,
		row,
		row?.kind === "panel" ? "instance.manage" : "backup.view",
		"BACKUP_NOT_FOUND",
	);
	// A database's backup: the request's gate counts as on the database row
	// (restore also needs database.write, download database.credentials.reveal).
	if (backup.templateId === DATABASE_TEMPLATE_ID && actor.gate) {
		for (const required of databaseRowRequirements(actor.gate)) {
			assertCanAccess(actor, required);
		}
	}
	return backup;
}

/** Delete one backup: the archive at the destination, then the row. */
export async function deleteBackup(actor: Actor, id: string): Promise<void> {
	const row = await getBackupRow(actor, id);
	const destination = await getDestinationRow(actor, row.destinationId);
	if (row.path) {
		const server = await pickServer(actor, row.serverId ?? undefined);
		const executor = await getExecutor(server);
		const session = await openRclone(
			executor,
			destination,
			newWorkDir("delete"),
		);
		try {
			const removed = await session.run([
				"deletefile",
				session.remotePath(row.path),
			]);
			// Already gone is fine; other errors keep the row.
			if (
				removed.exitCode !== 0 &&
				!/not found|doesn't exist|no such/i.test(removed.stderr)
			) {
				throw new AppError("BACKUP_DELETE_FAILED", {
					detail: clip(removed.stderr, TEXT_LIMITS.errorDetail),
				});
			}
			await removeEmptyParent(session, row.path);
		} finally {
			await session.close().catch(() => undefined);
			executor.close();
		}
	}
	await db.delete(backups).where(eq(backups.id, row.id));
	audit({
		actor,
		action: "backup.delete",
		targetType: "backup",
		targetId: row.id,
	});
}

// Backup rows of jobs a dead process left `running` can never finish.
registerJobRecovery("backups", {
	async onInterrupted(deploymentIds) {
		await db
			.update(backups)
			.set({
				status: "failed",
				...errorColumns(new AppError("JOB_INTERRUPTED")),
				finishedAt: new Date(),
			})
			.where(
				and(
					inArray(backups.deploymentId, deploymentIds),
					eq(backups.status, "running"),
				),
			);
	},
});
