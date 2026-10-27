import { eq } from "drizzle-orm";
import { appSourceKindOf } from "#/config/app-sources.ts";
import { destinationCapabilities } from "#/config/backup-drivers.ts";
import { jobTitle } from "#/config/job-titles.ts";
import { getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { backups } from "#/db/schema/backups.ts";
import {
	type BeforeUpHook,
	type CommandFailure,
	type DeployMode,
	run,
	runDeploy,
	setStatus,
	startAppJob,
} from "#/features/apps/app-jobs.server.ts";
import {
	appInputs,
	assertDeleteConfirmation,
	containerName,
	createAppRecord,
	encryptCustomSpec,
	encryptServiceEnv,
	getAppManifest,
	getAppRow,
	getAppServer,
	pendingEnvColumns,
	readCustomSpec,
	storedAppInputs,
} from "#/features/apps/apps.server.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import type { Actor } from "#/features/auth/access.ts";
import {
	type JobContext,
	type JobOutcome,
	redactingContext,
	startJob,
} from "#/features/deployments/deployments.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import { backupDatabaseService } from "#/features/templates/schema.ts";
import { getTemplateManifest } from "#/features/templates/templates.server.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { clip } from "#/libs/format.ts";
import { databaseStrategyFor, serverPlugins } from "#/plugins/server.ts";
import {
	appContainerCheckScript,
	bindSourcesCheckScript,
	composeLifecycleCommand,
	composeProjectCommand,
	resolvedBindSources,
} from "#/server/services/apps/commands.ts";
import {
	domainDerivedVariables,
	initialisedNames,
} from "#/server/services/apps/env-state.ts";
import { audit } from "#/server/services/audit.ts";
import {
	assertSafeListing,
	type BackupManifest,
	checksumsCommand,
	ENV_FILE,
	ensureToolsImageCommand,
	extractArchiveCommand,
	fileDigestCommand,
	listArchiveCommand,
	MANIFEST_FILE,
	parseChecksums,
	parseFileDigest,
	parseTarListing,
	resetSourceCommand,
	restoreSourceCommand,
	verifyManifest,
} from "#/server/services/backup/archive.ts";
import { rcloneFailure } from "#/server/services/backup/rclone.ts";
import {
	errorColumns,
	errorInfoOf,
	lastErrorColumns,
	redactError,
} from "#/server/services/error-info.ts";
import { type Executor, shellQuote } from "#/server/services/executor.ts";
import { assertServerOwned } from "#/server/services/server-setup.ts";
import {
	TemplateError,
	templateError,
} from "#/server/services/templates/naming.ts";
import { belowMinVersion } from "#/server/services/templates/versions.ts";
import { decrypt } from "#/utils/crypto.ts";
import { AppError, coded, commandError } from "#/utils/error.ts";
import {
	composeVolumeNames,
	type EnvPayload,
	getBackupRow,
	resolvedComposeModel,
	toolsImage,
} from "./backups.server";
import { getDestinationRow, pickServer } from "./destinations.server";
import { newWorkDir, openRclone, type RcloneSession } from "./rclone.server";
import type {
	BackupRow,
	DestinationRow,
	RestoreClonePreview,
	RestoreInput,
} from "./schema";

/**
 * Restore = fetch + verify + safely extract the archive in a staging folder
 * on the target server, put the backed-up env on the app, then a normal
 * deploy at the backed-up commit whose `beforeUp` step loads volumes and the
 * database through containers (never through host paths of volumes).
 */

/** The archive itself is bad (checksum, listing, manifest): mark it corrupt. */
class ArchiveIntegrityError extends AppError<"ARCHIVE_CORRUPT"> {
	constructor(reason: ErrorInfo) {
		super("ARCHIVE_CORRUPT", { reason: { $error: reason } });
		this.name = "ArchiveIntegrityError";
	}
}

async function markCorrupt(backup: BackupRow, error: unknown): Promise<void> {
	await db
		.update(backups)
		.set({ status: "corrupt", ...errorColumns(error), verifiedAt: null })
		.where(eq(backups.id, backup.id));
}

export interface Fetched {
	manifest: BackupManifest;
	env: EnvPayload;
}

/** Run a structural check; its failure means the archive is corrupt. */
function integrity<T>(check: () => T): T {
	try {
		return check();
	} catch (error) {
		throw new ArchiveIntegrityError(errorInfoOf(error));
	}
}

/** Download, checksum-verify, guard-list, extract and verify members. */
export async function fetchArchive(
	executor: Executor,
	session: RcloneSession,
	backup: BackupRow,
	ctx: JobContext,
): Promise<Fetched> {
	const config = getConfig();
	const work = session.workDir;
	const exec = (command: string, failure: CommandFailure) =>
		run(executor, ctx, command, failure, {
			quiet: true,
			timeoutMs: config.BACKUP_JOB_TIMEOUT_MS,
		});
	if (!backup.path || !backup.checksum) {
		throw new TemplateError("BACKUP_NO_ARCHIVE");
	}
	ctx.event("restore.downloading", { path: backup.path });
	const download = await session.run(
		["copyto", session.remotePath(backup.path), "/work/archive.tar.zst"],
		{ signal: ctx.signal },
	);
	if (download.exitCode !== 0) {
		throw rcloneFailure("download", session.redact(download.stderr), ctx);
	}
	const digest = parseFileDigest(
		await exec(
			fileDigestCommand(`${work}/archive.tar.zst`),
			"ARCHIVE_READ_FAILED",
		),
	);
	if (digest.sha256 !== backup.checksum) {
		throw new ArchiveIntegrityError(coded("ARCHIVE_CHECKSUM_CHANGED"));
	}
	ctx.event("restore.checksum_ok");
	const tools = toolsImage();
	await exec(ensureToolsImageCommand(tools), "BACKUP_TOOLS_FAILED");
	const listing = parseTarListing(
		await exec(listArchiveCommand(tools.image, work), "ARCHIVE_LIST_FAILED"),
	);
	integrity(() => assertSafeListing(listing));
	await exec(
		extractArchiveCommand(tools.image, work),
		"ARCHIVE_EXTRACT_FAILED",
	);
	const checksums = parseChecksums(
		await exec(checksumsCommand(`${work}/x`), "ARCHIVE_CHECKSUM_FAILED"),
	);
	const manifestText = await executor.readFile(`${work}/x/${MANIFEST_FILE}`);
	const manifest = integrity(() =>
		verifyManifest(JSON.parse(manifestText), checksums),
	);
	ctx.event("restore.members_ok");
	const env = JSON.parse(
		decrypt(await executor.readFile(`${work}/x/${ENV_FILE}`)),
	) as EnvPayload;
	return { manifest, env };
}

/** beforeUp: replace data with the archive's (app stopped), load the DB. */
export function restoreData(
	session: RcloneSession,
	fetched: Fetched,
	ctx: JobContext,
): BeforeUpHook {
	const step: BeforeUpHook = async ({ executor, location, rendered, app }) => {
		const config = getConfig();
		const tools = toolsImage();
		const work = session.workDir;
		const exec = (command: string, failure: CommandFailure) =>
			run(executor, ctx, command, failure, {
				quiet: true,
				timeoutMs: config.BACKUP_JOB_TIMEOUT_MS,
			});
		// Volume/DB loads exec into the app's containers: they must be its own.
		await exec(
			appContainerCheckScript(Object.values(rendered.containerNames), app.id),
			"RESTORE_FOREIGN_CONTAINER",
		);
		const manifest = await getAppManifest(app);
		const plan = manifest.backup;

		// Volume keys → Docker names from the resolved model (compose applies
		// the project prefix; the rendered model has no names).
		const volumeNames = composeVolumeNames(
			await resolvedComposeModel(executor, app, ctx),
		);
		const missing = fetched.manifest.members.filter(
			(member) =>
				member.kind === "volume" &&
				member.source &&
				plan.volumes.includes(member.source) &&
				!volumeNames[member.source],
		);
		if (missing.length) {
			// Restoring without them loses data (e.g. Supabase's pgsodium key).
			throw new TemplateError("RESTORE_VOLUMES_MISSING", {
				volumes: { $list: missing.map((member) => member.source ?? "") },
			});
		}

		ctx.event("restore.stopping");
		await exec(
			composeProjectCommand(location.folder, ["down", "--remove-orphans"]),
			"COMPOSE_DOWN_FAILED",
		);
		await exec(
			composeLifecycleCommand(location, [
				"create",
				"--no-build",
				"--remove-orphans",
			]),
			"COMPOSE_CREATE_FAILED",
		);
		const allowedPaths = new Set(plan.paths);
		const targets: {
			member: string;
			target: string;
			source: string;
			volume: boolean;
		}[] = [];
		for (const member of fetched.manifest.members) {
			if (member.kind === "path" && member.source) {
				if (!allowedPaths.has(member.source)) {
					ctx.event("restore.path_skipped", { path: member.source });
					continue;
				}
				targets.push({
					member: member.path,
					target: `${location.appRoot}/${member.source}`,
					source: member.source,
					volume: false,
				});
			}
			if (member.kind === "volume" && member.source) {
				const name = volumeNames[member.source];
				if (!name || !plan.volumes.includes(member.source)) {
					ctx.event("restore.volume_skipped", { volume: member.source });
					continue;
				}
				targets.push({
					member: member.path,
					target: name,
					source: member.source,
					volume: true,
				});
			}
		}
		const databaseService = backupDatabaseService(plan);
		const restoringDatabase = !!fetched.manifest.database && !!databaseService;
		const resets = restoringDatabase
			? plan.reset.map((item) => `${location.appRoot}/${item}`)
			: [];
		const resetVolumes = restoringDatabase
			? plan.reset_volumes.map((volume) => {
					const name = volumeNames[volume];
					if (!name) {
						throw new TemplateError("RESTORE_RESET_VOLUME_MISSING", { volume });
					}
					return { volume, name };
				})
			: [];
		const hostTargets = [
			...targets
				.map((item) => item.target)
				.filter((target) => target.startsWith("/")),
			...resets,
		];
		if (hostTargets.length) {
			// The app is down: no container can swap a folder for a symlink now.
			await exec(
				bindSourcesCheckScript(location, hostTargets),
				"RESTORE_UNSAFE_PATH",
			);
		}
		for (const item of targets) {
			if (item.volume) {
				ctx.event("restore.restoring_volume", { volume: item.source });
			} else {
				ctx.event("restore.restoring_path", { path: item.source });
			}
			await exec(
				restoreSourceCommand(tools.image, item.target, work, item.member),
				(detail) =>
					item.volume
						? new AppError("RESTORE_VOLUME_FAILED", {
								volume: item.source,
								detail,
							})
						: new AppError("RESTORE_PATH_FAILED", {
								path: item.source,
								detail,
							}),
			);
		}
		if (restoringDatabase && databaseService && fetched.manifest.database) {
			const strategy = databaseStrategyFor(app.templateId, manifest);
			if (
				!strategy ||
				!strategy.accepts.includes(fetched.manifest.database.strategy)
			) {
				throw new TemplateError("RESTORE_STRATEGY_UNAVAILABLE", {
					strategy: fetched.manifest.database.strategy,
				});
			}
			const dump = fetched.manifest.members.find(
				(member) => member.kind === "db",
			);
			if (!dump) throw new TemplateError("ARCHIVE_NO_DUMP");
			for (const reset of resets) {
				ctx.event("restore.reset_path", {
					path: reset.slice(location.appRoot.length + 1),
				});
				await exec(
					resetSourceCommand(tools.image, reset),
					"RESTORE_RESET_FOLDER_FAILED",
				);
			}
			for (const reset of resetVolumes) {
				ctx.event("restore.reset_volume", { volume: reset.volume });
				await exec(
					resetSourceCommand(tools.image, reset.name),
					"RESTORE_RESET_VOLUME_FAILED",
				);
			}
			ctx.event("restore.db_starting", { service: databaseService });
			await exec(
				composeLifecycleCommand(location, [
					"up",
					"-d",
					"--wait",
					"--no-build",
					shellQuote(databaseService),
				]),
				(detail) =>
					new AppError("SERVICE_START_FAILED", {
						service: databaseService,
						detail,
					}),
			);
			const restore = await executor.exec(
				`${strategy.restoreCommand(containerName(app.folder, databaseService))} < ${shellQuote(`${work}/x/${dump.path}`)}`,
				{ timeoutMs: config.BACKUP_JOB_TIMEOUT_MS },
			);
			const errors = restore.stderr
				.split("\n")
				// psql: "ERROR:  …"; mysql/mariadb: "ERROR 1050 (42S01) at line …".
				.filter((line) => /ERROR(:| \d+ )/.test(line));
			// Roles/objects the image's init scripts own can't be dropped or
			// re-created: expected, the backed-up definitions still apply.
			// MySQL 8+ refuses to drop its `mysql` schema (the dump's DROP
			// DATABASE for it): the tables are still replaced one by one.
			const expected =
				/already exists|cannot be dropped|Access to system schema 'mysql' is rejected/;
			if (restore.exitCode !== 0 && (errors.length === 0 || strategy.strict)) {
				throw commandError(
					"RESTORE_DATABASE_FAILED",
					clip(
						errors.length ? errors.slice(0, 5).join("\n") : restore.stderr,
						TEXT_LIMITS.storedError,
					),
				);
			}
			const conflicts = errors.filter((line) => expected.test(line));
			const other = errors.filter((line) => !expected.test(line));
			ctx.event("restore.db_loaded", {
				conflicts: conflicts.length,
				errors: other.length,
			});
			for (const line of other.slice(0, 20)) {
				ctx.event("restore.sql_warning", { line });
			}
			if (other.length > 0) {
				// Finished, but not cleanly: the job is marked with warnings.
				await ctx.addWarnings?.(other.length);
				ctx.event("restore.db_errors", { count: other.length });
			}
			if (strategy.restartAfterRestore) {
				await exec(
					composeLifecycleCommand(location, [
						"restart",
						shellQuote(databaseService),
					]),
					(detail) =>
						new AppError("SERVICE_RESTART_FAILED", {
							service: databaseService,
							detail,
						}),
				);
			}
			const afterRestore = serverPlugins[app.templateId]?.afterRestoreData;
			if (afterRestore) {
				// A restart doesn't wait for health: the plugin step queries it.
				await exec(
					composeLifecycleCommand(location, [
						"up",
						"-d",
						"--wait",
						"--no-build",
						shellQuote(databaseService),
					]),
					(detail) =>
						new AppError("SERVICE_START_FAILED", {
							service: databaseService,
							detail,
						}),
				);
				await afterRestore({
					executor,
					location,
					pluginConfig: manifest.plugin,
					values: rendered.values,
					toolsImage: tools.image,
					container: (service) => containerName(app.folder, service),
					job: ctx,
				});
			}
		}
		// Restored data is container-written and may hold symlinks: if a
		// backup path contains another bind source, that source could now be
		// a link. Check every bind source again before `up` mounts them.
		await exec(
			bindSourcesCheckScript(
				location,
				resolvedBindSources(rendered.composeModel),
			),
			"RESTORE_UNSAFE_BIND",
		);
	};
	// From `compose down` to the loaded data: a cancel waits for the end.
	return async (input) => {
		await (ctx.critical
			? ctx.critical("restore_data", () => step(input))
			: step(input));
		ctx.setCancelState?.("restore_data_done");
	};
}

/** Apply the archive's env/version to the app row (before rendering). */
export async function applyArchiveState(
	app: AppRow,
	fetched: Fetched,
	options: { keepPorts: boolean; previousHost: string | null },
): Promise<void> {
	const overrides = Object.fromEntries(
		Object.entries(fetched.env.overrides).filter(
			// A clone gets its own domain: drop values tied to the old one.
			([, value]) =>
				!options.previousHost || !value.includes(options.previousHost),
		),
	);
	const manifest = await getAppManifest(app).catch(() => null);
	if (options.previousHost) {
		// ...except credentials the user may edit (e.g. an owner email built
		// from the domain): the restored data still knows the original value,
		// so the clone keeps it and the login keeps working.
		for (const name of keptCloneCredentials(manifest)) {
			const value = fetched.env.values[name];
			if (value !== undefined) overrides[name] = value;
		}
	}
	await setStatus(app.id, {
		// Pending until the restore's deploy succeeds.
		...pendingEnvColumns(app, fetched.env.values),
		serviceEnvEncrypted: encryptServiceEnv(fetched.env.serviceEnv),
		inputs: storedAppInputs({
			...appInputs(app),
			overrides,
			publishedPorts: options.keepPorts
				? fetched.env.publishedPorts
				: appInputs(app).publishedPorts,
			// The restored data was initialised with the archive's env: its
			// initial_only values are frozen from now on.
			initialised: initialisedNames(
				manifest?.variables ?? {},
				fetched.env.values,
			),
		}),
		...(fetched.env.custom
			? { customSpecEncrypted: encryptCustomSpec(fetched.env.custom) }
			: {}),
		version: fetched.manifest.template.version,
		commitSha: fetched.manifest.template.commitSha || null,
		needsRedeploy: false,
	});
}

/** Restore `backup` over (or into) an app inside a running job. */
export async function runRestore(
	input: {
		backup: BackupRow;
		destination: DestinationRow;
		appId: string;
		clone: boolean;
	},
	ctx: JobContext,
): Promise<JobOutcome> {
	const [app] = await db
		.select()
		.from(apps)
		.where(eq(apps.id, input.appId))
		.limit(1);
	if (!app) return { success: false, error: new AppError("APP_NOT_FOUND") };
	const executor = await getExecutor(await getAppServer(app));
	let session: RcloneSession | null = null;
	try {
		ctx.setCancelState?.("restore_nothing_changed");
		// Never restore onto a server another Nitrobase instance manages.
		await assertServerOwned(executor, await requireInstanceId());
		const workDir = newWorkDir("restore");
		await ctx.setWorkDir?.(workDir);
		session = await openRclone(executor, input.destination, workDir);
		const redacting = redactingContext(ctx, session.redact);
		const fetched = await fetchArchive(
			executor,
			session,
			input.backup,
			redacting,
		);
		if (fetched.manifest.app.templateId !== app.templateId) {
			throw new TemplateError("RESTORE_TEMPLATE_MISMATCH", {
				template: fetched.manifest.app.templateId,
			});
		}
		await applyArchiveState(app, fetched, {
			keepPorts: !input.clone,
			previousHost: input.clone ? fetched.env.primaryHost : null,
		});
		const mode: DeployMode = fetched.manifest.template.commitSha
			? "redeploy"
			: "deploy";
		const outcome = await runDeploy(app.id, mode, undefined, redacting, {
			beforeUp: restoreData(session, fetched, redacting),
		});
		if (outcome.success) {
			ctx.event("restore.done", {
				app: fetched.manifest.app.name,
				date: { $date: fetched.manifest.createdAt },
			});
		}
		return outcome;
	} catch (error) {
		if (error instanceof ArchiveIntegrityError) {
			await markCorrupt(input.backup, error);
			// Nothing was touched yet: the app keeps running as it was.
			await setStatus(app.id, {
				status: app.status,
				...lastErrorColumns(null),
			});
			return { success: false, error };
		}
		const safe = session ? redactError(error, session.redact) : error;
		await setStatus(app.id, { status: "error", ...lastErrorColumns(safe) });
		return { success: false, error: safe };
	} finally {
		await session?.close().catch(() => undefined);
		if (session) await ctx.setWorkDir?.(null);
		executor.close();
	}
}

type Manifest = Awaited<ReturnType<typeof getAppManifest>>;

/**
 * Values derived from the domain that a clone keeps: editable credentials
 * and `initial_only` variables (the restored data was initialised with
 * them, e.g. an admin email built from the domain).
 */
function keptCloneCredentials(manifest: Manifest | null): string[] {
	if (!manifest) return [];
	const derived = domainDerivedVariables(
		Object.fromEntries(
			Object.entries(manifest.variables).map(([name, variable]) => [
				name,
				variable.value,
			]),
		),
	);
	return Object.entries(manifest.variables)
		.filter(
			([name, variable]) =>
				derived.has(name) &&
				((variable.credential && variable.editable) || variable.initial_only),
		)
		.map(([name]) => name);
}

/**
 * What "restore as a new app" changes, from the backup's template: values
 * derived from the domain are recomputed for the new domain, except
 * editable credentials, which keep the original value. Secrets are copied.
 */
export async function restoreClonePreview(
	actor: Actor,
	backupId: string,
): Promise<RestoreClonePreview> {
	const backup = await getBackupRow(actor, backupId);
	const blocked = await cloneVersionRefusal(backup);
	if (!backup.templateId) {
		return { recomputed: [], kept: [], fromData: [], blocked };
	}
	// The version too: database apps take their variables from the engine
	// it names (the base template has none).
	const manifest = await getAppManifest({
		templateId: backup.templateId,
		customSpecEncrypted: backup.customSpecEncrypted,
		version: backup.version ?? "",
	}).catch(() => null);
	if (!manifest) return { recomputed: [], kept: [], fromData: [], blocked };
	const kept = new Set(keptCloneCredentials(manifest));
	const derived = domainDerivedVariables(
		Object.fromEntries(
			Object.entries(manifest.variables).map(([name, variable]) => [
				name,
				variable.value,
			]),
		),
	);
	const describe = (name: string) => ({
		name,
		label: manifest.variables[name]?.label ?? name,
	});
	// The app keeps its own copy of these (e.g. an admin password changed in
	// its dashboard): the restored data decides, whatever the env says.
	const fromData = Object.entries(manifest.variables)
		.filter(([, variable]) => variable.initial_only && variable.credential)
		.map(([name]) => name);
	return {
		recomputed: [...derived].filter((name) => !kept.has(name)).map(describe),
		kept: [...kept].filter((name) => !fromData.includes(name)).map(describe),
		fromData: fromData.map(describe),
		blocked,
	};
}

/**
 * A new app cannot be made from a backup of a version below the
 * template's `min_version` (e.g. Supabase releases whose compose the
 * policy refuses): refused before any job, with a way forward. Restoring
 * over the existing app redeploys its pinned commit and stays possible.
 */
async function cloneVersionRefusal(
	backup: Pick<BackupRow, "templateId" | "version">,
): Promise<ErrorInfo | null> {
	if (!backup.templateId) return null;
	const manifest = await getTemplateManifest(backup.templateId).catch(
		() => null,
	);
	if (!manifest || manifest.source.type !== "github" || !backup.version) {
		return null;
	}
	const minVersion = belowMinVersion(manifest.source, backup.version);
	return minVersion
		? coded("BACKUP_RESTORE_VERSION_UNSUPPORTED", {
				template: manifest.name,
				version: backup.version,
				minVersion,
			})
		: null;
}

/** Start a restore job: overwrite the backup's app, or clone into a new app. */
export async function startRestore(
	actor: Actor,
	input: RestoreInput,
): Promise<{ appId: string; deploymentId: string }> {
	const backup = await getBackupRow(actor, input.id);
	if (backup.status !== "success" || backup.kind === "panel") {
		throw new AppError("BACKUP_RESTORE_NOT_SUCCESSFUL");
	}
	const destination = await getDestinationRow(actor, backup.destinationId);
	let app: AppRow;
	if (input.mode === "overwrite") {
		if (!backup.appId) {
			throw new AppError("BACKUP_RESTORE_APP_DELETED");
		}
		app = await getAppRow(actor, backup.appId);
		assertDeleteConfirmation(app, input.confirmName);
	} else {
		if (!backup.templateId) {
			throw new AppError("BACKUP_RESTORE_TEMPLATE_UNKNOWN");
		}
		const refused = await cloneVersionRefusal(backup);
		if (refused) throw templateError(refused);
		// A custom-compose app's routes come from its compose spec: the one
		// stored with the backup (works after the app is deleted), else the
		// source app's for backups made before that column existed. The
		// archive's own spec is applied later either way.
		const source =
			backup.customSpecEncrypted || !backup.appId
				? null
				: await getAppRow(actor, backup.appId).catch(() => null);
		const custom = readCustomSpec(backup) ?? (source && readCustomSpec(source));
		const kind = appSourceKindOf(
			(await getTemplateManifest(backup.templateId)).source.type,
		);
		if (kind === "git") {
			throw new AppError("BACKUP_RESTORE_GIT_CLONE");
		}
		if (!custom && kind === "custom-compose") {
			throw new AppError("BACKUP_RESTORE_NO_SPEC");
		}
		app = await createAppRecord(actor, {
			templateId: backup.templateId,
			serverId: input.serverId,
			name: input.name,
			version: backup.version ?? undefined,
			domain: input.domain || undefined,
			inputs: {},
			custom: custom ?? undefined,
			// The backed-up app was deployed with the template's warnings shown.
			acknowledged: true,
		});
	}
	// An on-server destination lives on the server that made the backup.
	if (
		destinationCapabilities(destination.type).onServer &&
		backup.serverId !== app.serverId
	) {
		if (input.mode === "clone")
			await db.delete(apps).where(eq(apps.id, app.id));
		throw new AppError("BACKUP_RESTORE_LOCAL_ONLY");
	}
	audit({
		actor,
		action: `backup.restore.${input.mode}`,
		targetType: "backup",
		targetId: backup.id,
		meta: { appId: app.id },
	});
	const { deploymentId } = await startAppJob(
		app,
		actor,
		"app_restore",
		jobTitle(
			input.mode === "clone" ? "app_restore_clone" : "app_restore_overwrite",
			{ app: backup.appName ?? app.name },
		),
		(ctx) =>
			runRestore(
				{ backup, destination, appId: app.id, clone: input.mode === "clone" },
				ctx,
			),
	);
	return { appId: app.id, deploymentId };
}

/**
 * Verify an archive without restoring: download it to a server, check the
 * sha256, the listing and every member against manifest.json (app
 * backups), or the sha256 alone (Nitrobase backups, encrypted). A failed
 * check marks the backup `corrupt`; success records `verifiedAt`.
 */
export async function startVerifyBackup(
	actor: Actor,
	id: string,
): Promise<{ deploymentId: string }> {
	const backup = await getBackupRow(actor, id);
	if (!backup.path || !backup.checksum) {
		throw new AppError("BACKUP_NO_ARCHIVE");
	}
	const destination = await getDestinationRow(actor, backup.destinationId);
	const server = await pickServer(
		actor,
		destinationCapabilities(destination.type).onServer
			? (backup.serverId ?? undefined)
			: undefined,
	);
	audit({
		actor,
		action: "backup.verify",
		targetType: "backup",
		targetId: backup.id,
	});
	return startJob(
		{
			actor,
			serverId: server.id,
			appId: backup.appId ?? undefined,
			type: "backup_verify",
			title: jobTitle("backup_verify", {
				file: backup.path.split("/").pop() ?? backup.id,
			}),
		},
		async (ctx) => {
			const executor = await getExecutor(server);
			let session: RcloneSession | null = null;
			try {
				const workDir = newWorkDir("verify");
				await ctx.setWorkDir?.(workDir);
				session = await openRclone(executor, destination, workDir);
				const redacting = redactingContext(ctx, session.redact);
				if (backup.kind === "panel") {
					await verifyChecksumOnly(executor, session, backup, redacting);
				} else {
					await fetchArchive(executor, session, backup, redacting);
				}
				await db
					.update(backups)
					.set({ verifiedAt: new Date() })
					.where(eq(backups.id, backup.id));
				ctx.event("restore.verified");
				return { success: true };
			} catch (error) {
				if (error instanceof ArchiveIntegrityError) {
					await markCorrupt(backup, error);
					return { success: false, error };
				}
				return {
					success: false,
					error: session ? redactError(error, session.redact) : error,
				};
			} finally {
				await session?.close().catch(() => undefined);
				if (session) await ctx.setWorkDir?.(null);
				executor.close();
			}
		},
	);
}

async function verifyChecksumOnly(
	executor: Executor,
	session: RcloneSession,
	backup: BackupRow,
	ctx: JobContext,
): Promise<void> {
	ctx.event("restore.downloading", { path: backup.path ?? "" });
	const download = await session.run(
		["copyto", session.remotePath(backup.path ?? ""), "/work/archive.bin"],
		{ signal: ctx.signal },
	);
	if (download.exitCode !== 0) {
		throw rcloneFailure("download", download.stderr, ctx);
	}
	const digest = parseFileDigest(
		await run(
			executor,
			ctx,
			fileDigestCommand(`${session.workDir}/archive.bin`),
			"ARCHIVE_READ_FAILED",
			{ quiet: true },
		),
	);
	if (digest.sha256 !== backup.checksum) {
		throw new ArchiveIntegrityError(coded("ARCHIVE_CHECKSUM_CHANGED"));
	}
	ctx.event("restore.checksum_ok");
}
