import { hostname } from "node:os";
import { and, eq, sql } from "drizzle-orm";
import { jobTitle } from "#/config/job-titles.ts";
import { getConfig } from "#/config/server.ts";
import { APP_VERSION } from "#/config/version.ts";
import { db } from "#/db/index.ts";
import { servers } from "#/db/schema/server.ts";
import { settings } from "#/db/schema/settings.ts";
import { type Actor, assertCanAccess } from "#/features/auth/access.ts";
import {
	getDestinationRow,
	pickServer,
} from "#/features/backups/destinations.server.ts";
import { performPanelBackup } from "#/features/backups/self-backup.server.ts";
import {
	type JobContext,
	type JobOutcome,
	listRunningJobs,
	registerJobRecovery,
	startJob,
} from "#/features/deployments/deployments.server.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { ensurePanelAttached } from "#/features/settings/instance.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import { audit } from "#/server/services/audit.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import { type Executor, shellQuote as q } from "#/server/services/executor.ts";
import {
	instancePauseReason,
	instanceUpgrading,
	setInstanceUpgrading,
} from "#/server/services/instance-state.ts";
import { isInContainer } from "#/server/services/local.ts";
import {
	detectInstall,
	envVersion,
	type PanelInstall,
	VERSION_LINE_ERE,
} from "#/server/services/upgrade/install.ts";
import {
	findRelease,
	isNewerRelease,
} from "#/server/services/upgrade/releases.ts";
import {
	isTerminal,
	outcomeOfUpdater,
	phaseOfLine,
	replayPhases,
	transition,
	type UpgradeOutcome,
	type UpgradePhase,
} from "#/server/services/upgrade/state-machine.ts";
import {
	parseUpdaterState,
	updaterClearCommand,
	updaterRunCommand,
	updaterStateCommand,
} from "#/server/services/upgrade/updater-script.ts";
import { AppError, commandError, type DetailErrorCode } from "#/utils/error.ts";
import {
	fetchReleases,
	getInstanceUpdate,
	installGuideUrl,
} from "./release.server";
import type {
	StartUpgradeInput,
	UpgradeBlocker,
	UpgradeOverview,
} from "./schema";

/**
 * In-panel Nitrobase upgrade (instance admins). The panel job takes a
 * self-backup, pulls the new image and starts the updater container
 * (#/server/services/upgrade/updater-script.ts), which recreates the panel
 * on the new image and rolls back to the old one when it does not become
 * healthy. The job row survives the restart: the panel that comes up (new
 * or restored) adopts it, appends the updater's log and finishes it.
 *
 * Database rollback is NOT automatic: migrations of the new version have
 * run by the time it is healthy (or failed half-way). Going back to an
 * older version after that = the self-backup taken first (README).
 */

const STATE_KEY = "instance.upgrade";

interface UpgradeState {
	deploymentId: string;
	from: string;
	to: string;
	teamId: string;
	userId: string | null;
	serverId: string;
	startedAt: string;
	phase: UpgradePhase;
	/** Updater log lines already appended to the job. */
	consumed: number;
	outcome: UpgradeOutcome | null;
}

async function readState(): Promise<UpgradeState | null> {
	const [row] = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, STATE_KEY))
		.limit(1);
	const value = (row?.value as { upgrade?: UpgradeState } | undefined)?.upgrade;
	return value ?? null;
}

async function writeState(state: UpgradeState): Promise<void> {
	await db
		.insert(settings)
		.values({
			key: STATE_KEY,
			value: { upgrade: state },
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: { upgrade: state }, updatedAt: new Date() },
		});
}

/**
 * Compare-and-set on the stored state of `deploymentId`: only one panel
 * (the old one still alive, or the new one) appends a given updater line
 * or finishes the job.
 */
async function updateStateIf(
	deploymentId: string,
	expected: Pick<UpgradeState, "consumed" | "outcome">,
	patch: Partial<UpgradeState>,
): Promise<UpgradeState | null> {
	const current = await readState();
	if (
		!current ||
		current.deploymentId !== deploymentId ||
		current.consumed !== expected.consumed ||
		current.outcome !== expected.outcome
	) {
		return null;
	}
	const next = { ...current, ...patch };
	const updated = await db
		.update(settings)
		.set({ value: { upgrade: next }, updatedAt: new Date() })
		.where(
			and(
				eq(settings.key, STATE_KEY),
				sql`${settings.value} = ${JSON.stringify({ upgrade: current })}::jsonb`,
			),
		)
		.returning({ key: settings.key });
	return updated.length ? next : null;
}

async function localServer(): Promise<ServerRow> {
	const [server] = await db
		.select()
		.from(servers)
		.where(eq(servers.isDefault, true))
		.limit(1);
	if (!server) throw new AppError("SERVER_NOT_FOUND");
	return server;
}

/** How this panel is installed, as the host's Docker sees it. */
async function detectPanelInstall(
	executor: Executor,
): Promise<{ install: PanelInstall } | { problem: UpgradeBlocker }> {
	const config = getConfig();
	if (!isInContainer()) return { problem: "not_container" };
	const timeoutMs = config.UPGRADE_HOST_COMMAND_TIMEOUT_MS;
	const inspect = await executor.exec(
		`docker inspect ${q(config.PANEL_CONTAINER)}`,
		{
			timeoutMs,
		},
	);
	const detected = detectInstall({
		inspect: inspect.exitCode === 0 ? inspect.stdout : null,
		hostname: hostname(),
		inContainer: true,
	});
	if ("problem" in detected) return detected;
	// Only the version line leaves the host's .env (it holds the secrets).
	const env = await executor.exec(
		`grep -E '${VERSION_LINE_ERE}' ${q(`${detected.install.workingDir}/.env`)} || true`,
		{ timeoutMs: getConfig().UPGRADE_HOST_COMMAND_TIMEOUT_MS },
	);
	if (envVersion(env.stdout) !== detected.install.imageTag) {
		return { problem: "env_missing" };
	}
	return detected;
}

export async function getUpgradeOverview(
	actor: Actor,
	options: { refresh?: boolean } = {},
): Promise<UpgradeOverview> {
	assertCanAccess(actor, "instance.manage");
	const update = await getInstanceUpdate(options);
	const state = await readState();
	let blocker: UpgradeBlocker | null = null;
	let install: UpgradeOverview["install"] = null;
	if (instancePauseReason()) blocker = "paused";
	else if (instanceUpgrading() || (state && !state.outcome)) {
		blocker = "upgrading";
	} else {
		const executor = await getExecutor(await localServer());
		try {
			const detected = await detectPanelInstall(executor);
			if ("problem" in detected) blocker = detected.problem;
			else {
				install = {
					dir: detected.install.workingDir,
					image: detected.install.image,
				};
			}
		} finally {
			executor.close();
		}
		if (!blocker && !update.available) blocker = "no_update";
	}
	return {
		update,
		blocker,
		install,
		last: state
			? {
					deploymentId: state.deploymentId,
					from: state.from,
					to: state.to,
					phase: state.phase,
					outcome: state.outcome,
					startedAt: state.startedAt,
				}
			: null,
		installGuideUrl: installGuideUrl(),
	};
}

async function exec(
	executor: Executor,
	ctx: JobContext,
	command: string,
	failure: DetailErrorCode,
	options: { timeoutMs?: number; log?: boolean } = {},
): Promise<string> {
	const result = await executor.exec(command, {
		timeoutMs: options.timeoutMs,
		signal: ctx.signal,
		onStdout: options.log ? (chunk) => ctx.log(chunk.trimEnd()) : undefined,
	});
	if (result.exitCode !== 0) {
		throw commandError(
			failure,
			(result.stderr || result.stdout).trim().split("\n").slice(-4).join(" "),
		);
	}
	return result.stdout;
}

export async function startPanelUpgrade(
	actor: Actor,
	input: StartUpgradeInput,
): Promise<{ deploymentId: string }> {
	assertCanAccess(actor, "instance.manage");
	if (instancePauseReason()) throw new AppError("INSTANCE_PAUSED");
	if (instanceUpgrading()) throw new AppError("INSTANCE_UPGRADING");
	const release = findRelease(await fetchReleases(), input.version);
	if (!release) {
		throw new AppError("UPGRADE_RELEASE_NOT_FOUND", { version: input.version });
	}
	if (!isNewerRelease(APP_VERSION, release)) {
		throw new AppError("UPGRADE_NOT_NEWER", {
			version: input.version,
			current: APP_VERSION,
		});
	}
	const running = listRunningJobs();
	if (running.length > 0) {
		throw new AppError("UPGRADE_JOBS_RUNNING", { count: running.length });
	}
	const destination = await getDestinationRow(actor, input.destinationId);
	const backupServer = await pickServer(actor, input.serverId);
	const server = await localServer();
	const probe = await getExecutor(server);
	let install: PanelInstall;
	try {
		const detected = await detectPanelInstall(probe);
		if ("problem" in detected) {
			throw new AppError("UPGRADE_UNAVAILABLE", { reason: detected.problem });
		}
		install = detected.install;
	} finally {
		probe.close();
	}
	audit({
		actor,
		action: "settings.instance_upgrade",
		meta: { from: APP_VERSION, to: release.version },
	});
	const config = getConfig();
	return startJob(
		{
			actor: { teamId: server.teamId, userId: actor.userId },
			serverId: server.id,
			type: "panel_upgrade",
			title: jobTitle("panel_upgrade", { version: release.version }),
		},
		async (ctx) => {
			setInstanceUpgrading(ctx.deploymentId);
			let phase: UpgradePhase = "preflight";
			let handedOff = false;
			const executor = await getExecutor(server);
			try {
				ctx.event("upgrade.starting", {
					from: APP_VERSION,
					to: release.version,
					image: install.imageRepo,
				});
				if (release.url) ctx.event("upgrade.notes", { url: release.url });
				ctx.event("upgrade.db_note");

				phase = transition(phase, "backup");
				ctx.event("upgrade.step_backup");
				await performPanelBackup(
					{
						actor,
						destinationId: destination.id,
						serverId: backupServer.id,
						trigger: "manual",
					},
					ctx,
				);

				phase = transition(phase, "pull");
				const image = `${install.imageRepo}:${release.version}`;
				ctx.event("upgrade.step_pull", { image });
				// Release tags are immutable: an image already on the host (an
				// air-gapped install loads it with `docker load`) is used as is.
				await exec(
					executor,
					ctx,
					`docker image inspect ${q(image)} >/dev/null 2>&1 && echo "${image} is already on this host" || docker pull ${q(image)}`,
					"UPGRADE_PULL_FAILED",
					{ timeoutMs: config.UPGRADE_PULL_TIMEOUT_MS, log: true },
				);
				await exec(
					executor,
					ctx,
					`docker image inspect ${q(config.UPDATER_IMAGE)} >/dev/null 2>&1 || docker pull ${q(config.UPDATER_IMAGE)}`,
					"UPGRADE_UPDATER_PULL_FAILED",
					{ timeoutMs: config.UPGRADE_PULL_TIMEOUT_MS },
				);

				// Jobs may have started before this job set the upgrading flag
				// (between the check in startPanelUpgrade and here): the panel
				// restarts next, so none may run.
				const others = listRunningJobs().filter(
					(id) => id !== ctx.deploymentId,
				);
				if (others.length > 0) {
					throw new AppError("UPGRADE_JOBS_RUNNING", { count: others.length });
				}
				phase = transition(phase, "handoff");
				const state: UpgradeState = {
					deploymentId: ctx.deploymentId,
					from: install.imageTag,
					to: release.version,
					teamId: server.teamId,
					userId: actor.userId,
					serverId: server.id,
					startedAt: new Date().toISOString(),
					phase,
					consumed: 0,
					outcome: null,
				};
				await writeState(state);
				// A finished updater of an earlier upgrade blocks the name.
				await exec(
					executor,
					ctx,
					updaterClearCommand(config.UPDATER_CONTAINER),
					"UPGRADE_UPDATER_START_FAILED",
				);
				ctx.event("upgrade.step_updater");
				await exec(
					executor,
					ctx,
					updaterRunCommand(
						{
							install,
							targetVersion: release.version,
							previousVersion: install.imageTag,
							healthTimeoutSeconds: config.UPGRADE_HEALTH_TIMEOUT_SECONDS,
							healthPollSeconds: config.UPGRADE_HEALTH_POLL_SECONDS,
							logTailLines: config.UPGRADE_LOG_TAIL_LINES,
							updaterImage: config.UPDATER_IMAGE,
							updaterContainer: config.UPDATER_CONTAINER,
							dockerSocket: config.DOCKER_SOCKET,
							deploymentId: ctx.deploymentId,
							instanceId: await requireInstanceId(),
						},
						config.PANEL_CONTAINER,
					),
					"UPGRADE_UPDATER_START_FAILED",
				);
				handedOff = true;
				return await followUpdater(ctx, executor, state);
			} catch (error) {
				if (!handedOff) {
					// Nothing changed on the host: the old version keeps running.
					const current = await readState();
					if (current?.deploymentId === ctx.deploymentId) {
						await writeState({
							...current,
							phase: "failed",
							outcome: "failed",
						});
					}
					setInstanceUpgrading(null);
				}
				throw error;
			} finally {
				executor.close();
			}
		},
	);
}

/**
 * Follow the updater until it exits: append its new log lines (once, see
 * `updateStateIf`), then finish the job from its exit code. Runs in the
 * old panel (until it is stopped) and in the panel that comes up.
 */
async function followUpdater(
	ctx: JobContext,
	executor: Executor,
	start: UpgradeState,
): Promise<JobOutcome> {
	const config = getConfig();
	const deadline = Date.now() + config.UPGRADE_FOLLOW_TIMEOUT_MS;
	let state = start;
	const container = config.UPDATER_CONTAINER;
	for (;;) {
		const raw = await executor.exec(updaterStateCommand(container), {
			timeoutMs: getConfig().UPGRADE_HOST_COMMAND_TIMEOUT_MS,
		});
		const updater = parseUpdaterState(raw.stdout);
		if (!updater || updater.deploymentId !== state.deploymentId) {
			return finish(ctx, state, "failed", new AppError("UPGRADE_UPDATER_GONE"));
		}
		const logs = await executor.exec(`docker logs ${q(container)} 2>&1`, {
			timeoutMs: getConfig().UPGRADE_HOST_COMMAND_TIMEOUT_MS,
		});
		const lines = logs.stdout.split("\n").filter((line) => line.length > 0);
		const fresh = lines.slice(state.consumed);
		if (fresh.length) {
			const phase = replayPhases(state.phase, fresh);
			const next = await updateStateIf(
				state.deploymentId,
				{ consumed: state.consumed, outcome: null },
				{ consumed: lines.length, phase },
			);
			if (next) {
				for (const line of fresh) {
					const marker = phaseOfLine(line);
					if (marker) ctx.event("upgrade.phase", { phase: marker });
					else ctx.event("upgrade.updater_line", { line });
				}
				state = next;
			} else {
				const latest = await readState();
				if (!latest || latest.deploymentId !== state.deploymentId) {
					return finish(
						ctx,
						state,
						"failed",
						new AppError("UPGRADE_STATE_CHANGED"),
					);
				}
				if (latest.outcome) {
					// Another panel finished it.
					return outcomeResult(latest);
				}
				state = latest;
			}
		}
		if (updater.status === "exited" || updater.status === "dead") {
			const outcome = outcomeOfUpdater(
				updater.exitCode,
				replayPhases("handoff", lines),
			);
			return finish(ctx, state, outcome);
		}
		if (Date.now() > deadline) {
			return finish(
				ctx,
				state,
				"failed",
				new AppError("UPGRADE_UPDATER_TIMEOUT", { container }),
			);
		}
		await new Promise((resolve) => setTimeout(resolve, config.UPGRADE_POLL_MS));
	}
}

function outcomeResult(state: UpgradeState): JobOutcome {
	if (state.outcome === "succeeded") return { success: true };
	return {
		success: false,
		error:
			state.outcome === "rolled_back"
				? new AppError("UPGRADE_ROLLED_BACK", {
						to: state.to,
						from: state.from,
					})
				: new AppError("UPGRADE_FAILED", { to: state.to }),
	};
}

async function finish(
	ctx: JobContext,
	state: UpgradeState,
	outcome: UpgradeOutcome,
	detail?: AppError,
): Promise<JobOutcome> {
	const finished = await updateStateIf(
		state.deploymentId,
		{ consumed: state.consumed, outcome: null },
		{ outcome, phase: isTerminal(state.phase) ? state.phase : outcome },
	);
	const final = finished ?? (await readState()) ?? { ...state, outcome };
	if (finished) {
		if (detail) {
			ctx.event("job.error", { error: { $error: errorInfoOf(detail) } });
		}
		const config = getConfig();
		const executor = await getExecutor(await localServer());
		try {
			await executor.exec(
				`docker rm -f ${q(config.UPDATER_CONTAINER)} >/dev/null 2>&1; true`,
				{ timeoutMs: config.UPGRADE_CLEANUP_TIMEOUT_MS },
			);
		} finally {
			executor.close();
		}
		if (outcome === "succeeded") {
			ctx.event("upgrade.succeeded", { to: state.to, panel: APP_VERSION });
		} else if (outcome === "rolled_back") {
			ctx.event("upgrade.rolled_back", { from: state.from });
		} else {
			ctx.event("upgrade.unknown_state");
		}
		audit({
			teamId: state.teamId,
			userId: state.userId,
			action: "settings.instance_upgrade_result",
			meta: { from: state.from, to: state.to, outcome },
		});
	}
	setInstanceUpgrading(null);
	// The recreated container lost its attachment to the panel network.
	await ensurePanelAttached().catch((error) =>
		ctx.event("upgrade.panel_network", {
			error: { $error: errorInfoOf(error) },
		}),
	);
	return outcomeResult(final);
}

/**
 * Boot: an upgrade whose job was running when the old panel stopped is
 * adopted (not failed by orphan recovery) and followed to its end.
 */
registerJobRecovery("panel-upgrade", {
	async adopt() {
		const state = await readState();
		if (!state || state.outcome) return [];
		setInstanceUpgrading(state.deploymentId);
		setTimeout(() => {
			void startJob(
				{
					actor: { teamId: state.teamId, userId: state.userId },
					serverId: state.serverId,
					type: "panel_upgrade",
					title: jobTitle("panel_upgrade", { version: state.to }),
					resume: state.deploymentId,
				},
				async (ctx) => {
					ctx.event("upgrade.following", { version: APP_VERSION });
					const executor = await getExecutor(await localServer());
					try {
						return await followUpdater(ctx, executor, state);
					} finally {
						executor.close();
					}
				},
			).catch((error) => {
				setInstanceUpgrading(null);
				console.error("[upgrade] could not resume the upgrade job", error);
			});
		}, 0);
		return [state.deploymentId];
	},
});
