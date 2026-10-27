import { and, eq, inArray } from "drizzle-orm";
import { destinationCapabilities } from "#/config/backup-drivers.ts";
import { jobTitle } from "#/config/job-titles.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { db } from "#/db/index.ts";
import { apps, domains } from "#/db/schema/apps.ts";
import { alerts } from "#/db/schema/monitoring.ts";
import { deployments, servers } from "#/db/schema/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import {
	performAppBackup,
	runningServices,
} from "#/features/backups/backups.server.ts";
import { getDestinationRow } from "#/features/backups/destinations.server.ts";
import {
	newWorkDir,
	openRclone,
	type RcloneSession,
} from "#/features/backups/rclone.server.ts";
import {
	applyArchiveState,
	fetchArchive,
	restoreData,
} from "#/features/backups/restore.server.ts";
import type { DestinationRow } from "#/features/backups/schema.ts";
import {
	consoleJobContext,
	type JobContext,
	type JobOutcome,
	redactingContext,
	registerJobRecovery,
	startJob,
} from "#/features/deployments/deployments.server.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import {
	getExecutor,
	getServerRow,
} from "#/features/servers/servers.server.ts";
import { clip } from "#/libs/format.ts";
import {
	composeServiceCommand,
	composeStartServicesCommand,
} from "#/server/services/apps/commands.ts";
import { audit } from "#/server/services/audit.ts";
import { getFreeDomainProvider } from "#/server/services/domains/free-domains.ts";
import {
	errorInfoOf,
	lastErrorColumns,
	redactError,
} from "#/server/services/error-info.ts";
import type { Executor } from "#/server/services/executor.ts";
import { AppError } from "#/utils/error.ts";
import {
	logWarning,
	run,
	runDeploy,
	setStatus,
	teardownApp,
} from "./app-jobs.server";
import {
	appLocation,
	deployedServices,
	getAppRow,
	getAppServer,
	listAppDomains,
	resolveServerIps,
} from "./apps.server";
import type { AppRow, DomainRow } from "./schema";

/**
 * Move an app to another Ready server of the same team, built on backup and
 * restore:
 *  1. back up on the source (the app is stopped from then on, so nothing is
 *     written that the copy would miss);
 *  2. restore the same app (same id, env, data) on the target, with routes;
 *     free domains (sslip.io...) are re-pointed at the target's IP;
 *  3. the deploy's health checks must pass on the target;
 *  4. only then the app row switches to the target and the source copy is
 *     removed.
 * Any failure before the switch rolls back: the target copy is removed, the
 * app row and domains are restored and the source app is started again.
 * The destination must be reachable from both servers (not a server folder).
 */

export interface MoveInput {
	appId: string;
	targetServerId: string;
	destinationId: string;
}

const MOVABLE = new Set(["running", "stopped", "error"]);

async function assertMovable(
	actor: Actor,
	app: AppRow,
	target: ServerRow,
	destination: DestinationRow,
): Promise<void> {
	const fail = (code: MoveRefusal) => {
		throw new AppError(code);
	};
	if (target.id === app.serverId) fail("APP_MOVE_SAME_SERVER");
	if (target.teamId !== actor.teamId) fail("APP_MOVE_OTHER_TEAM");
	if (target.status !== "ready") fail("APP_MOVE_TARGET_NOT_READY");
	const [down] = await db
		.select({ id: alerts.id })
		.from(alerts)
		.where(
			and(
				eq(alerts.serverId, target.id),
				eq(alerts.rule, "server_unreachable"),
				eq(alerts.status, "open"),
			),
		)
		.limit(1);
	if (down) fail("APP_MOVE_TARGET_UNREACHABLE");
	if (!MOVABLE.has(app.status)) fail("APP_MOVE_BUSY");
	if (deployedServices(app).length === 0) fail("APP_MOVE_NOT_DEPLOYED");
	if (destinationCapabilities(destination.type).onServer) {
		fail("APP_MOVE_LOCAL_DESTINATION");
	}
	const [clash] = await db
		.select({ id: apps.id })
		.from(apps)
		.where(and(eq(apps.serverId, target.id), eq(apps.folder, app.folder)))
		.limit(1);
	if (clash) fail("APP_MOVE_FOLDER_TAKEN");
}

/** Why a move is refused before it starts. */
type MoveRefusal =
	| "APP_MOVE_SAME_SERVER"
	| "APP_MOVE_OTHER_TEAM"
	| "APP_MOVE_TARGET_NOT_READY"
	| "APP_MOVE_TARGET_UNREACHABLE"
	| "APP_MOVE_BUSY"
	| "APP_MOVE_NOT_DEPLOYED"
	| "APP_MOVE_LOCAL_DESTINATION"
	| "APP_MOVE_FOLDER_TAKEN";

/** Free-provider hosts re-pointed at `ip`; user domains stay as they are. */
function repointedHosts(
	app: AppRow,
	rows: DomainRow[],
	ip: string | undefined,
): Map<string, string> {
	const changes = new Map<string, string>();
	const primary = rows.find((row) => row.primary);
	if (!ip || !primary?.provider) return changes;
	const provider = getFreeDomainProvider(primary.provider);
	// Keep the generated label ("my-blog" or the folder), only the IP part changes.
	const label = primary.host.split(".")[0] || app.folder;
	const next = provider.hostFor(label, ip);
	if (next === primary.host) return changes;
	for (const row of rows) {
		if (row.provider && row.host.endsWith(primary.host)) {
			changes.set(row.id, `${row.host.slice(0, -primary.host.length)}${next}`);
		}
	}
	return changes;
}

async function setHosts(rows: DomainRow[], hosts: Map<string, string>) {
	for (const row of rows) {
		const host = hosts.get(row.id);
		if (host) {
			await db
				.update(domains)
				.set({ host, checks: {}, lastCheckedAt: null })
				.where(eq(domains.id, row.id));
		}
	}
}

export async function startMoveApp(
	actor: Actor,
	input: MoveInput,
): Promise<{ deploymentId: string }> {
	const app = await getAppRow(actor, input.appId, "app.move");
	const target = await getServerRow(actor, input.targetServerId, "app.move");
	const destination = await getDestinationRow(actor, input.destinationId);
	await assertMovable(actor, app, target, destination);
	// Links are a private network on one server: unlink before moving.
	const { countAppLinks } = await import(
		"#/features/databases/links.server.ts"
	);
	if ((await countAppLinks(app.id)) > 0) {
		throw new AppError("APP_HAS_DATABASE_LINKS");
	}
	const source = await getAppServer(app);
	audit({
		actor,
		action: "app.move",
		targetType: "app",
		targetId: app.id,
		meta: { from: source.id, to: target.id, destinationId: destination.id },
	});
	return startJob(
		{
			actor,
			serverId: source.id,
			// Nothing else may run on the target while the app lands there.
			alsoLock: [target.id],
			appId: app.id,
			type: "app_move",
			title: jobTitle("app_move", { app: app.name, target: target.name }),
		},
		(ctx) => runMove({ actor, app, source, target, destination }, ctx),
	);
}

/** The move job (exported for tests). */
export async function runMove(
	input: {
		actor: Actor;
		app: AppRow;
		source: ServerRow;
		target: ServerRow;
		destination: DestinationRow;
	},
	jobCtx: JobContext,
): Promise<JobOutcome> {
	const ctx = jobCtx;
	const { actor, app, source, target, destination } = input;
	const location = appLocation(app);
	const originalDomains = await listAppDomains(app.id);
	let sourceExec: Executor | null = null;
	let targetExec: Executor | null = null;
	let session: RcloneSession | null = null;
	let landed = false;
	let stoppedSource = false;
	/**
	 * Services running on the source before the move (compose ps): a
	 * rollback starts exactly these, so an app stopped before stays stopped.
	 */
	let wasRunning: string[] = [];
	let hosts = new Map<string, string>();
	ctx.setCancelState?.("move_not_started");

	const rollback = async (reason: unknown): Promise<JobOutcome> => {
		// Runs to the end even when the job was cancelled (no abort signal).
		const ctx = { ...jobCtx, signal: undefined };
		const info = errorInfoOf(reason);
		ctx.event("job.error", { error: { $error: info } });
		ctx.event("move.rolling_back");
		try {
			if (landed && targetExec) {
				await teardownApp(
					targetExec,
					app,
					{ wipeData: true, removeImages: false },
					ctx,
				);
			}
		} catch (error) {
			ctx.event("move.target_copy_left", {
				server: target.name,
				error: { $error: errorInfoOf(error) },
			});
		}
		// The row's env/version/domains go back to what the source runs.
		await db
			.update(apps)
			.set({
				serverId: source.id,
				envEncrypted: app.envEncrypted,
				envPendingAt: app.envPendingAt,
				envDeployedEncrypted: app.envDeployedEncrypted,
				serviceEnvEncrypted: app.serviceEnvEncrypted,
				customSpecEncrypted: app.customSpecEncrypted,
				inputs: app.inputs,
				version: app.version,
				commitSha: app.commitSha,
				composeDeployed: app.composeDeployed,
				needsRedeploy: app.needsRedeploy,
				updatedAt: new Date(),
			})
			.where(eq(apps.id, app.id));
		await setHosts(
			originalDomains,
			new Map(originalDomains.map((row) => [row.id, row.host])),
		);
		const restart = stoppedSource ? wasRunning : [];
		if (restart.length && sourceExec) {
			try {
				ctx.event("move.restarting_source", {
					app: app.name,
					server: source.name,
				});
				await run(
					sourceExec,
					ctx,
					composeStartServicesCommand(location, restart),
					"APP_MOVE_SOURCE_START_FAILED",
				);
				await ctx.servicesStarted?.(restart);
			} catch (error) {
				logWarning(ctx, error);
			}
		}
		await setStatus(app.id, {
			status: restart.length ? "running" : app.status,
			...lastErrorColumns(null),
		});
		await jobCtx.setRollback?.(null);
		return {
			success: false,
			// The full output is in the log above; the job keeps a summary.
			error: new AppError("APP_MOVE_ROLLED_BACK", {
				reason: {
					$error: info.code
						? info
						: { ...info, text: summarizeError(info.text ?? "") },
				},
			}),
		};
	};

	try {
		sourceExec = await getExecutor(source);
		targetExec = await getExecutor(target);

		const services = deployedServices(app);
		wasRunning = await runningServices(sourceExec, ctx, location, services);
		// 1. Backup on the source; it stays stopped from here on.
		ctx.event("move.backing_up", { app: app.name, server: source.name });
		const backup = await performAppBackup(
			{
				appId: app.id,
				actor,
				destination,
				trigger: "manual",
				deploymentId: ctx.deploymentId,
				keepStopped: true,
			},
			ctx,
		);
		// The job recovery starts again only what was running.
		await ctx.servicesStopped?.(wasRunning);
		stoppedSource = true;
		ctx.event("move.stopping_source", { app: app.name, server: source.name });
		await run(
			sourceExec,
			ctx,
			composeServiceCommand(location, "stop"),
			"APP_MOVE_SOURCE_STOP_FAILED",
		);
		ctx.setCancelState?.("move_rolled_back");

		// 2. Restore the same app on the target.
		const ips = await resolveServerIps(target).catch(() => [] as string[]);
		hosts = repointedHosts(app, originalDomains, ips[0]);
		const previousPrimary = originalDomains.find((row) => row.primary);
		// Recorded before anything changes: if Nitrobase dies from here on,
		// boot recovery undoes the move (see the hook below).
		const recovery: MoveRollback = {
			kind: "app_move",
			appId: app.id,
			sourceServerId: source.id,
			targetServerId: target.id,
			hosts: Object.fromEntries(
				originalDomains.map((row) => [row.id, row.host]),
			),
			landed: false,
		};
		await ctx.setRollback?.({ ...recovery });
		if (hosts.size) {
			await setHosts(originalDomains, hosts);
			ctx.event("move.domains_repointed", {
				ip: ips[0] ?? "",
				hosts: { $list: [...hosts.values()] },
			});
		}
		const workDir = newWorkDir("restore");
		await ctx.setWorkDir?.(workDir);
		session = await openRclone(targetExec, destination, workDir);
		const redacting = redactingContext(ctx, session.redact);
		const [fresh] = await db
			.select()
			.from(apps)
			.where(eq(apps.id, app.id))
			.limit(1);
		const fetched = await fetchArchive(targetExec, session, backup, redacting);
		await applyArchiveState(fresh ?? app, fetched, {
			keepPorts: true,
			// Values derived from a re-pointed free domain are recomputed.
			previousHost:
				previousPrimary && hosts.has(previousPrimary.id)
					? previousPrimary.host
					: null,
		});
		landed = true;
		await ctx.setRollback?.({ ...recovery, landed: true });
		ctx.event("move.deploying", { app: app.name, server: target.name });
		const outcome = await runDeploy(
			app.id,
			fetched.manifest.template.commitSha ? "redeploy" : "deploy",
			undefined,
			redacting,
			{ beforeUp: restoreData(session, fetched, redacting), server: target },
		);
		if (!outcome.success) {
			return await rollback(
				outcome.error ?? new AppError("APP_MOVE_DEPLOY_FAILED"),
			);
		}

		// 3. Healthy on the target: switch, then remove the source copy.
		await db
			.update(apps)
			.set({ serverId: target.id, routesPending: false, updatedAt: new Date() })
			.where(eq(apps.id, app.id));
		// Switched: nothing to undo any more (source leftovers are orphans).
		await ctx.setRollback?.(null);
		ctx.setCancelState?.("move_on_target");
		ctx.event("move.removing_source", { server: source.name });
		try {
			await teardownApp(
				sourceExec,
				app,
				{ wipeData: true, removeImages: false },
				ctx,
			);
		} catch (error) {
			ctx.event("move.source_copy_left", {
				server: source.name,
				error: { $error: errorInfoOf(error) },
			});
		}
		await ctx.servicesStarted?.("all");
		const userDomains = (await listAppDomains(app.id)).filter(
			(row) => !row.provider,
		);
		if (userDomains.length) {
			ctx.event("move.dns_hint", {
				hosts: { $list: userDomains.map((row) => row.host) },
				address: ips.length ? { $list: ips } : target.host,
				server: source.name,
			});
		}
		ctx.event("move.done", { app: app.name, server: target.name });
		return { success: true };
	} catch (error) {
		return await rollback(session ? redactError(error, session.redact) : error);
	} finally {
		await session?.close().catch(() => undefined);
		if (session) await ctx.setWorkDir?.(null);
		sourceExec?.close();
		targetExec?.close();
	}
}

/** First line of an error, shortened (the log keeps the full text). */
function summarizeError(text: string): string {
	const first =
		text
			.split("\n")
			.find((line) => line.trim())
			?.trim() ?? text;
	return first.length > TEXT_LIMITS.inlineError
		? `${clip(first, TEXT_LIMITS.inlineError)}…`
		: first;
}

/** Persisted on the job row while a move can still be undone. */
interface MoveRollback {
	kind: "app_move";
	appId: string;
	sourceServerId: string;
	targetServerId: string;
	/** Domain id -> host before free domains were re-pointed. */
	hosts: Record<string, string>;
	/** The restore on the target started (a copy may exist there). */
	landed: boolean;
}

function isMoveRollback(value: unknown): value is MoveRollback {
	const item = value as Partial<MoveRollback> | null;
	return (
		!!item &&
		item.kind === "app_move" &&
		typeof item.appId === "string" &&
		typeof item.sourceServerId === "string" &&
		typeof item.targetServerId === "string" &&
		typeof item.hosts === "object"
	);
}

/**
 * Boot recovery of a move a dead process left half-done (before the switch
 * to the target): original domain hosts back, the app on its source server
 * (the job runner then starts the services the move stopped there), the
 * copy on the target removed. The app is flagged for a redeploy because its
 * stored env may already hold values derived from re-pointed free domains.
 */
async function recoverInterruptedMove(state: MoveRollback): Promise<void> {
	const [app] = await db
		.select()
		.from(apps)
		.where(eq(apps.id, state.appId))
		.limit(1);
	if (!app) return;
	const rows = await listAppDomains(app.id);
	await setHosts(rows, new Map(Object.entries(state.hosts)));
	await db
		.update(apps)
		.set({
			serverId: state.sourceServerId,
			needsRedeploy: true,
			...lastErrorColumns(new AppError("APP_MOVE_INTERRUPTED")),
			updatedAt: new Date(),
		})
		.where(eq(apps.id, app.id));
	if (!state.landed) return;
	const [target] = await db
		.select()
		.from(servers)
		.where(eq(servers.id, state.targetServerId))
		.limit(1);
	if (!target) return;
	const executor = await getExecutor(target);
	try {
		await teardownApp(
			executor,
			app,
			{ wipeData: true, removeImages: false },
			consoleJobContext(`[move recovery ${app.id}]`),
		);
	} catch (error) {
		console.error(
			`[move recovery ${app.id}] could not remove the copy on ${target.name}; wipe it from the server's orphaned data`,
			error,
		);
	} finally {
		executor.close();
	}
}

registerJobRecovery("app-move", {
	async onInterrupted(deploymentIds) {
		const rows = await db
			.select({ rollback: deployments.rollback })
			.from(deployments)
			.where(
				and(
					inArray(deployments.id, deploymentIds),
					eq(deployments.type, "app_move"),
				),
			);
		for (const row of rows) {
			if (!isMoveRollback(row.rollback)) continue;
			await recoverInterruptedMove(row.rollback).catch((error) =>
				console.error("[jobs] move recovery failed", error),
			);
		}
	},
});
