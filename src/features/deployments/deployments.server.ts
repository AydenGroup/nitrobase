import { and, asc, desc, eq, gt, inArray, lt, notInArray } from "drizzle-orm";
import {
	type CancelState,
	type JobLogArgs,
	type JobLogEvent,
	type JobStep,
	logEventText,
} from "#/config/job-log-events.ts";
import { type JobTitle, titleFor } from "#/config/job-titles.ts";
import { getEventDefinition } from "#/config/notification-events.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { deploymentLogs, deployments, servers } from "#/db/schema/server.ts";
import {
	type CodedParams,
	type ErrorInfo,
	errorInfo,
	redactCodedParams,
} from "#/libs/coded.ts";
import {
	createLineDeduper,
	formatLogLine,
	logLinesFrom,
} from "#/libs/job-log.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import { emitEvent } from "#/server/services/events/bus.ts";
import { serverI18n } from "#/server/services/i18n.ts";
import {
	instancePauseReason,
	instanceUpgrading,
} from "#/server/services/instance-state.ts";
import {
	createIdleHooks,
	type IdleListener,
} from "#/server/services/jobs/idle-hooks.ts";
import {
	isAppBusy as appBusy,
	appLockKey,
	isServerJobBlocked,
	isServerMutationBlocked,
} from "#/server/services/jobs/locks.ts";
import {
	type InterruptedJob,
	type JobOwner,
	type JobRecoveryHooks,
	recoverInterruptedJobs as recoverJobs,
} from "#/server/services/jobs/recovery.ts";
import { createSseStream } from "#/server/services/sse.ts";
import { AppError } from "#/utils/error.ts";

export type { JobOwner, JobRecoveryHooks };

/**
 * How a job ended. `error` is an AppError (stored as code + params and
 * shown in the reader's language) or raw text/Error (tool output, shown
 * as is).
 */
export type JobOutcome = { success: boolean; error?: unknown };

/** Writes to a job log: panel events (coded) and raw output. */
export interface JobLogger {
	/** A panel event, rendered in the reader's language (#/config/job-log-events.ts). */
	event: <E extends JobLogEvent>(code: E, ...params: JobLogArgs<E>) => void;
	/**
	 * Raw output of a command (never panel text): multi-line text becomes
	 * one timestamped line per line.
	 */
	log: (output: string) => void;
}

export interface JobContext extends JobLogger {
	deploymentId: string;
	/** Aborted when a user cancels the job: pass it to long commands. */
	signal?: AbortSignal;
	/**
	 * Record app services this job stopped (persisted before returning, so
	 * a crash right after still knows). Call `servicesStarted` once they run
	 * again; whatever is left when the job ends is restarted by recovery.
	 */
	servicesStopped?: (services: string[]) => Promise<void>;
	servicesStarted?: (services: string[] | "all") => Promise<void>;
	/** Record (or clear) the job's staging folder on the server. */
	setWorkDir?: (path: string | null) => Promise<void>;
	/** Record (or clear) what boot recovery must undo if the process dies. */
	setRollback?: (state: Record<string, unknown> | null) => Promise<void>;
	/** Count problems the job tolerated (success with warnings). */
	addWarnings?: (count: number) => Promise<void>;
	/**
	 * Run a step that must not be interrupted half-way (e.g. restore between
	 * `compose down` and the data load): a cancel request waits for it.
	 */
	critical?: <T>(label: JobStep, step: () => Promise<T>) => Promise<T>;
	/** What a cancel landing now leaves behind (logged if the job is cancelled). */
	setCancelState?: (state: CancelState) => void;
	/**
	 * App-scoped jobs (lock "app", e.g. a git build): run `step` holding the
	 * server lock too, waiting until no other server-level job holds it
	 * (deploy step after a build). Server-level jobs already hold it.
	 */
	withServerLock?: <T>(step: () => Promise<T>) => Promise<T>;
}

// On globalThis like the job state: the startup plugin registers the hooks
// and server functions run the jobs, possibly from separate module
// instances (dev SSR), so a module-level array could be empty for them.
// Keyed by owner so an HMR re-evaluation replaces instead of duplicating.
const globalHooks = globalThis as typeof globalThis & {
	__nitrobaseRecoveryHookMap?: Map<string, JobRecoveryHooks>;
};
globalHooks.__nitrobaseRecoveryHookMap ??= new Map();
const hookRegistry = globalHooks.__nitrobaseRecoveryHookMap;
const recoveryHooksList = () => [...hookRegistry.values()];

export function registerJobRecovery(id: string, hooks: JobRecoveryHooks): void {
	hookRegistry.set(id, hooks);
}

/** One job log line: raw text, or an event (`code` + `params`). */
interface JobLogLine {
	seq: number;
	/** `[HH:MM:SS] text` (events: in the source language). */
	line: string;
	code?: string | null;
	params?: CodedParams | null;
}

type JobEvent =
	| ({ type: "log" } & JobLogLine)
	| {
			type: "done";
			status: "success" | "failed";
			errorMessage: string | null;
			error: ErrorInfo | null;
	  };

interface LiveJob {
	deploymentId: string;
	serverId: string;
	/** Most recent lines only (see getConfig().JOB_MEMORY_LINES); `lastSeq` counts all. */
	lines: JobLogLine[];
	lastSeq: number;
	flushFailures: number;
	keepLine: (line: string) => boolean;
	unflushed: JobLogLine[];
	flushing: Promise<void>;
	listeners: Set<(event: JobEvent) => void>;
	done: Extract<JobEvent, { type: "done" }> | null;
	teamId: string;
	appId: string | null;
	abort: AbortController;
	stopped: Set<string>;
	workDir: string | null;
	/** Tolerated problems (warning_count). */
	warnings: number;
	/** The running critical step, if any. */
	critical: JobStep | null;
	cancelPending: boolean;
	cancelState: CancelState | null;
	/** Holds an app lock only (scheduled tasks), not the server lock. */
	appScoped: boolean;
}

interface JobState {
	jobs: Map<string, LiveJob>;
	serverLocks: Set<string>;
	recovery: Promise<void> | null;
	idle: ReturnType<typeof createIdleHooks>;
}

const MAX_FLUSH_FAILURES = 10;

// Kept on globalThis so dev HMR reloads don't lose track of running jobs.
const globalJobs = globalThis as typeof globalThis & {
	__nitrobaseJobs?: JobState;
};
globalJobs.__nitrobaseJobs ??= {
	jobs: new Map(),
	serverLocks: new Set(),
	recovery: null,
	idle: createIdleHooks(),
};
globalJobs.__nitrobaseJobs.idle ??= createIdleHooks();
const state: JobState = globalJobs.__nitrobaseJobs;

/**
 * Resolve when a job has ended (status from its row): polls, so it also
 * works for jobs started elsewhere in this process.
 */
export async function waitForJob(
	deploymentId: string,
	pollMs: number,
): Promise<"success" | "failed"> {
	for (;;) {
		const [row] = await db
			.select({ status: deployments.status })
			.from(deployments)
			.where(eq(deployments.id, deploymentId))
			.limit(1);
		if (!row) return "failed";
		if (row.status === "success" || row.status === "failed") return row.status;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

/** Ids of the jobs running in this process. */
export function listRunningJobs(): string[] {
	return [...state.jobs.keys()];
}

/** Run `listener` whenever a server's job lock is released. */
export function onServerIdle(listener: IdleListener): () => void {
	return state.idle.on(listener);
}

function releaseServer(serverId: string): void {
	state.serverLocks.delete(serverId);
	void state.idle.notify(serverId);
}

/**
 * Jobs live in this process only, so any `running` deployment not tracked
 * here was interrupted by a restart. Runs once per process. Interrupted
 * jobs that left app services stopped or a staging folder behind are
 * handed to the recovery hooks (see `recoverInterruptedJobs`).
 */
export function recoverOrphanedJobs(): Promise<void> {
	// Paused instance (restored/cloned database): touching jobs or servers
	// here could fight the instance that really owns them.
	if (instancePauseReason()) return Promise.resolve();
	state.recovery ??= (async () => {
		const adopted: string[] = [];
		for (const hook of recoveryHooksList()) {
			try {
				adopted.push(...((await hook.adopt?.()) ?? []));
			} catch (error) {
				console.error("[jobs] adopting a job failed", error);
			}
		}
		const active = [...state.jobs.keys(), ...adopted];
		const interrupted = errorInfoOf(new AppError("JOB_INTERRUPTED"));
		const orphaned = await db
			.update(deployments)
			.set({
				status: "failed",
				errorMessage: interrupted.text,
				errorCode: interrupted.code,
				errorParams: interrupted.params,
				updatedAt: new Date(),
			})
			.where(
				and(
					inArray(deployments.status, ["pending", "running"]),
					active.length ? notInArray(deployments.id, active) : undefined,
				),
			)
			.returning({
				id: deployments.id,
				serverId: deployments.serverId,
				teamId: deployments.teamId,
				userId: deployments.userId,
				appId: deployments.appId,
				stoppedServices: deployments.stoppedServices,
				workDir: deployments.workDir,
			});
		const serverIds = [...new Set(orphaned.map((row) => row.serverId))].filter(
			(id) => !state.serverLocks.has(id),
		);
		if (serverIds.length) {
			await db
				.update(servers)
				.set({
					status: "error",
					lastError: interrupted.text,
					lastErrorCode: interrupted.code,
					lastErrorParams: interrupted.params,
					updatedAt: new Date(),
				})
				.where(
					and(
						inArray(servers.id, serverIds),
						eq(servers.status, "bootstrapping"),
					),
				);
		}
		// In the background: recovery jobs need the lock this may be waiting on.
		void recoverInterruptedJobs(orphaned).catch((error) =>
			console.error("[jobs] recovery of interrupted jobs failed", error),
		);
	})().catch((error) => {
		state.recovery = null;
		throw error;
	});
	return state.recovery;
}

/** Recover what interrupted jobs left behind (see #/server/services/jobs/recovery.ts). */
function recoverInterruptedJobs(jobs: InterruptedJob[]): Promise<void> {
	return recoverJobs(jobs, recoveryHooksList(), startJob);
}

/**
 * Ask a running job to stop (owner check is the caller's). Inside a
 * critical step the cancel is deferred until the step ends.
 */
export async function cancelJob(
	deploymentId: string,
): Promise<{ cancelled: boolean; deferred: boolean }> {
	const job = state.jobs.get(deploymentId);
	if (!job || job.done) return { cancelled: false, deferred: false };
	if (job.abort.signal.aborted || job.cancelPending) {
		return { cancelled: true, deferred: job.cancelPending };
	}
	await db
		.update(deployments)
		.set({ cancelRequestedAt: new Date() })
		.where(eq(deployments.id, deploymentId));
	if (job.critical) {
		job.cancelPending = true;
		appendEvent(job, "job.cancel_requested_wait", { step: job.critical });
		return { cancelled: true, deferred: true };
	}
	appendEvent(job, "job.cancel_requested");
	job.abort.abort();
	return { cancelled: true, deferred: false };
}

export function isServerBusy(serverId: string): boolean {
	return state.serverLocks.has(serverId);
}

function lockState() {
	return { serverLocks: state.serverLocks, jobs: [...state.jobs.values()] };
}

/**
 * An app-scoped job may not start: its app already has one, or a job of
 * the server that is not about another app (bootstrap, routes of the
 * panel…) or about this app (deploy, backup…) holds the server.
 */
export function isAppBusy(serverId: string, appId: string): boolean {
	return appBusy(lockState(), serverId, appId);
}

/**
 * Run a short DB mutation while holding the server lock, so no job can
 * start (and snapshot stale state) until it finishes. Throws SERVER_BUSY
 * when a job is running. App-scoped mutations pass `appId`: only that
 * app's own app-scoped job (build, task run) blocks them, not another
 * app's; server-level mutations (no `appId`) wait for every job.
 */
async function withServerLock<T>(
	serverId: string,
	fn: () => Promise<T>,
	options: { appId?: string } = {},
): Promise<T> {
	// Synchronous check-and-set, same as startJob.
	if (isServerMutationBlocked(lockState(), serverId, options.appId)) {
		throw new AppError("SERVER_BUSY");
	}
	state.serverLocks.add(serverId);
	try {
		return await fn();
	} finally {
		releaseServer(serverId);
	}
}

/** `withServerLock` for a mutation of one app (only its own jobs block it). */
export function withAppServerLock<T>(
	app: { id: string; serverId: string },
	fn: () => Promise<T>,
): Promise<T> {
	return withServerLock(app.serverId, fn, { appId: app.id });
}

function emit(job: LiveJob, event: JobEvent) {
	for (const listener of job.listeners) {
		try {
			listener(event);
		} catch {
			job.listeners.delete(listener);
		}
	}
}

function flush(job: LiveJob): Promise<void> {
	if (job.unflushed.length === 0) return job.flushing;
	const batch = job.unflushed.splice(0, job.unflushed.length);
	job.flushing = job.flushing.then(async () => {
		try {
			await db
				.insert(deploymentLogs)
				.values(
					batch.map(({ seq, line, code, params }) => ({
						deploymentId: job.deploymentId,
						seq,
						line,
						code: code ?? null,
						params: params ?? null,
					})),
				)
				// Retries after an ambiguous failure must not trip the unique index.
				.onConflictDoNothing();
			job.flushFailures = 0;
		} catch (error) {
			job.flushFailures += 1;
			console.error("[jobs] failed to persist logs", error);
			// Requeue for the next tick unless the DB keeps refusing (e.g. the
			// deployment row was deleted with its server).
			if (job.flushFailures < MAX_FLUSH_FAILURES) {
				job.unflushed.unshift(...batch);
			}
		}
	});
	return job.flushing;
}

function pushLine(job: LiveJob, entry: Omit<JobLogLine, "seq">) {
	const line: JobLogLine = { seq: ++job.lastSeq, ...entry };
	job.lines.push(line);
	if (job.lines.length > getConfig().JOB_MEMORY_LINES) job.lines.shift();
	job.unflushed.push(line);
	emit(job, { type: "log", ...line });
}

/** Raw output: one timestamped line per line, consecutive duplicates dropped. */
function appendLog(job: LiveJob, output: string) {
	for (const raw of logLinesFrom(output)) {
		if (!job.keepLine(raw)) continue;
		pushLine(job, { line: formatLogLine(raw) });
	}
	if (job.unflushed.length >= getConfig().JOB_FLUSH_BATCH_SIZE) void flush(job);
}

/**
 * A panel event: stored as code + params (rendered in the reader's
 * language), with its source-language text as the line.
 */
function appendEvent<E extends JobLogEvent>(
	job: LiveJob,
	code: E,
	...[params]: JobLogArgs<E>
) {
	const values = (params ?? {}) as CodedParams;
	const text = logEventText(serverI18n(), code, values) ?? code;
	if (!job.keepLine(text)) return;
	pushLine(job, { line: formatLogLine(text), code, params: values });
	if (job.unflushed.length >= getConfig().JOB_FLUSH_BATCH_SIZE) void flush(job);
}

/**
 * `ctx` with `redact` applied to everything it writes to the job log:
 * raw output and every text param of events (nested errors included).
 */
export function redactingContext(
	ctx: JobContext,
	redact: (text: string) => string,
): JobContext {
	return {
		...ctx,
		log: (output) => ctx.log(redact(output)),
		event: (code, ...[params]) =>
			(ctx.event as (code: string, params?: CodedParams) => void)(
				code,
				params && redactCodedParams(params as CodedParams, redact),
			),
	};
}

/**
 * A job context outside a job (boot recovery): events and output go to
 * the server console, in the source language.
 */
export function consoleJobContext(prefix: string): JobContext {
	return {
		deploymentId: "console",
		log: (output) => console.info(`${prefix} ${output}`),
		event: (code, ...[params]) =>
			console.info(
				`${prefix} ${logEventText(serverI18n(), code, params as CodedParams) ?? code}`,
			),
	};
}

async function readStoredLogs(
	deploymentId: string,
	afterSeq: number,
	beforeSeq?: number,
) {
	return db
		.select({
			seq: deploymentLogs.seq,
			line: deploymentLogs.line,
			code: deploymentLogs.code,
			params: deploymentLogs.params,
		})
		.from(deploymentLogs)
		.where(
			and(
				eq(deploymentLogs.deploymentId, deploymentId),
				gt(deploymentLogs.seq, afterSeq),
				beforeSeq === undefined ? undefined : lt(deploymentLogs.seq, beforeSeq),
			),
		)
		.orderBy(asc(deploymentLogs.seq));
}

/** `job.<type>.succeeded|failed` for the notification catalog. */
function emitJobEvent(
	params: {
		actor: JobOwner;
		serverId: string;
		appId?: string;
		type: string;
		title: JobTitle;
	},
	deploymentId: string,
	done: NonNullable<LiveJob["done"]>,
): void {
	const id = `job.${params.type}.${done.status === "success" ? "succeeded" : "failed"}`;
	if (!getEventDefinition(id)) return;
	emitEvent({
		id,
		teamId: params.actor.teamId,
		userId: params.actor.userId,
		subject: deploymentId,
		serverId: params.serverId,
		appId: params.appId ?? null,
		params: {
			job: params.type,
			title: {
				$job: {
					type: params.type,
					titleKey: params.title.key,
					titleParams: params.title.params ?? {},
				},
			},
			error: done.error ? { $error: done.error } : "",
		},
	});
}

/**
 * Create a deployment row and run `run` in the background. Only one job
 * may run per server at a time. Logs are persisted in batches to
 * `deployment_logs` and streamed live to subscribers.
 */
export async function startJob(
	params: {
		actor: JobOwner;
		serverId: string;
		/** Job kind (`jobTypes`). */
		type: string;
		/** Coded title (`jobTitle(key, params)`), rendered where shown. */
		title: JobTitle;
		appId?: string;
		/** More servers the job works on (e.g. a move's target): locked too. */
		alsoLock?: string[];
		/**
		 * "app": lock only the app (scheduled tasks), so jobs of other apps
		 * on the server keep running. Refused while a server-level job of
		 * the server (bootstrap…) or of this app runs.
		 */
		lock?: "server" | "app";
		/**
		 * Continue this existing (adopted) deployment instead of creating
		 * one: its stored log is kept and new lines follow it.
		 */
		resume?: string;
	},
	run: (ctx: JobContext) => Promise<JobOutcome>,
): Promise<{ deploymentId: string }> {
	if (instancePauseReason()) throw new AppError("INSTANCE_PAUSED");
	// While Nitrobase upgrades itself, the panel restarts: nothing new starts.
	if (instanceUpgrading() && !params.resume) {
		throw new AppError("INSTANCE_UPGRADING");
	}
	if (!params.resume) await recoverOrphanedJobs();

	// Check-and-set happens synchronously, so concurrent requests can't race.
	const appScoped = params.lock === "app" && !!params.appId;
	const locked = appScoped
		? [appLockKey(params.appId as string)]
		: [params.serverId, ...(params.alsoLock ?? [])];
	if (
		appScoped
			? isAppBusy(params.serverId, params.appId as string)
			: isServerJobBlocked(lockState(), params)
	) {
		throw new AppError("SERVER_BUSY");
	}
	for (const id of locked) state.serverLocks.add(id);

	const titleKey = params.title.key === params.type ? null : params.title.key;
	const titleParams: CodedParams = params.title.params ?? {};
	let deploymentId: string;
	let resumedSeq = 0;
	try {
		if (params.resume) {
			deploymentId = params.resume;
			const [last] = await db
				.select({ seq: deploymentLogs.seq })
				.from(deploymentLogs)
				.where(eq(deploymentLogs.deploymentId, deploymentId))
				.orderBy(desc(deploymentLogs.seq))
				.limit(1);
			resumedSeq = last?.seq ?? 0;
			await db
				.update(deployments)
				.set({ status: "running", updatedAt: new Date() })
				.where(eq(deployments.id, deploymentId));
		} else
			[{ id: deploymentId }] = await db
				.insert(deployments)
				.values({
					serverId: params.serverId,
					teamId: params.actor.teamId,
					userId: params.actor.userId,
					appId: params.appId ?? null,
					type: params.type,
					titleKey,
					titleParams,
					// Source-language copy for API v1 and older panel versions;
					// the UI renders titleKey + titleParams.
					title: titleFor(serverI18n(), {
						type: params.type,
						titleKey,
						titleParams,
					}),
					status: "running",
				})
				.returning({ id: deployments.id });
	} catch (error) {
		for (const id of locked) state.serverLocks.delete(id);
		throw error;
	}

	const job: LiveJob = {
		deploymentId,
		serverId: params.serverId,
		lines: [],
		lastSeq: resumedSeq,
		flushFailures: 0,
		keepLine: createLineDeduper(),
		unflushed: [],
		flushing: Promise.resolve(),
		listeners: new Set(),
		done: null,
		teamId: params.actor.teamId,
		appId: params.appId ?? null,
		abort: new AbortController(),
		stopped: new Set(),
		workDir: null,
		warnings: 0,
		critical: null,
		cancelPending: false,
		cancelState: null,
		appScoped,
	};
	state.jobs.set(deploymentId, job);
	const persist = (patch: Partial<typeof deployments.$inferInsert>) =>
		db.update(deployments).set(patch).where(eq(deployments.id, deploymentId));
	const ctx: JobContext = {
		deploymentId,
		log: (output) => appendLog(job, output),
		event: (code, ...params) => appendEvent(job, code, ...params),
		signal: job.abort.signal,
		servicesStopped: async (services) => {
			for (const service of services) job.stopped.add(service);
			await persist({ stoppedServices: [...job.stopped] });
		},
		servicesStarted: async (services) => {
			if (services === "all") job.stopped.clear();
			else for (const service of services) job.stopped.delete(service);
			await persist({
				stoppedServices: job.stopped.size ? [...job.stopped] : null,
			});
		},
		setWorkDir: async (path) => {
			job.workDir = path;
			await persist({ workDir: path });
		},
		setRollback: async (rollback) => {
			await persist({ rollback });
		},
		addWarnings: async (count) => {
			job.warnings += count;
			await persist({ warningCount: job.warnings });
		},
		setCancelState: (state) => {
			job.cancelState = state;
		},
		withServerLock: async (step) => {
			if (!appScoped) return step();
			const serverId = params.serverId;
			const deadline = Date.now() + getConfig().JOB_SERVER_LOCK_WAIT_MS;
			let announced = false;
			// Single-threaded check-and-set, as in startJob.
			while (state.serverLocks.has(serverId)) {
				if (job.abort.signal.aborted) throw new AppError("JOB_CANCELLED");
				if (Date.now() > deadline) throw new AppError("SERVER_BUSY");
				if (!announced) {
					appendEvent(job, "job.waiting_server");
					announced = true;
				}
				await new Promise((resolve) =>
					setTimeout(resolve, getConfig().JOB_LOCK_POLL_MS),
				);
			}
			state.serverLocks.add(serverId);
			try {
				return await step();
			} finally {
				releaseServer(serverId);
			}
		},
		critical: async (label, step) => {
			if (job.critical) return step();
			job.critical = label;
			try {
				return await step();
			} finally {
				job.critical = null;
				if (job.cancelPending) {
					appendEvent(job, "job.cancelling");
					job.abort.abort();
				}
			}
		},
	};

	void (async () => {
		const timer = setInterval(
			() => void flush(job),
			getConfig().JOB_FLUSH_INTERVAL_MS,
		);
		let outcome: JobOutcome;
		try {
			outcome = await run(ctx);
		} catch (error) {
			appendEvent(job, "job.error", { error: { $error: errorInfoOf(error) } });
			outcome = { success: false, error };
		}
		if (job.abort.signal.aborted && outcome.success === false) {
			outcome = { success: false, error: new AppError("JOB_CANCELLED") };
			if (job.cancelState) {
				appendEvent(job, "job.cancelled_state", { state: job.cancelState });
			} else {
				appendEvent(job, "job.cancelled");
			}
		}
		// Services the job left stopped (failure, cancel): start them again.
		if (job.stopped.size > 0 && job.appId) {
			const services = [...job.stopped];
			try {
				for (const hook of recoveryHooksList()) {
					await hook.restartServices?.(
						{ appId: job.appId, services },
						{ ...ctx, signal: undefined },
					);
				}
				await ctx.servicesStarted?.(services);
			} catch (error) {
				appendEvent(job, "job.restart_failed", {
					services: { $list: services },
					error: { $error: errorInfoOf(error) },
				});
			}
		}
		clearInterval(timer);

		const error = outcome.success
			? null
			: errorInfoOf(outcome.error ?? new AppError("JOB_FAILED"));
		const done: LiveJob["done"] = {
			type: "done",
			status: outcome.success ? "success" : "failed",
			errorMessage: error?.text ?? null,
			error,
		};
		emitJobEvent(params, deploymentId, done);
		try {
			// Final flush: retry briefly, since the job is forgotten afterwards.
			const config = getConfig();
			for (let attempt = 0; attempt < config.JOB_FLUSH_RETRIES; attempt++) {
				await flush(job);
				if (job.unflushed.length === 0) break;
				await new Promise((resolve) =>
					setTimeout(resolve, config.JOB_FLUSH_RETRY_BASE_MS * (attempt + 1)),
				);
			}
			await db
				.update(deployments)
				.set({
					status: done.status,
					errorMessage: error?.text ?? null,
					errorCode: error?.code ?? null,
					errorParams: error?.params ?? null,
					updatedAt: new Date(),
				})
				.where(eq(deployments.id, deploymentId));
		} catch (error) {
			console.error("[jobs] failed to finalize deployment", error);
		} finally {
			job.done = done;
			emit(job, done);
			job.listeners.clear();
			state.jobs.delete(deploymentId);
			for (const id of locked) releaseServer(id);
		}
	})();

	return { deploymentId };
}

/**
 * SSE stream for a deployment: replays stored logs after `afterSeq`, then
 * tails live lines until the job completes. Caller must check ownership.
 */
export function streamDeployment(
	deploymentId: string,
	afterSeq: number,
	signal: AbortSignal,
	onClose?: () => void,
	options: {
		/**
		 * Panel UI: `log` frames carry `{ line, code, params }` (events are
		 * rendered by the client). Otherwise (REST API) the line text only.
		 */
		coded?: boolean;
	} = {},
): ReadableStream<Uint8Array> {
	return createSseStream({
		signal,
		async start(channel) {
			if (onClose) channel.onClose(onClose);
			let lastSeq = afterSeq;
			const sendEvent = (event: JobEvent) => {
				if (event.type === "log") {
					if (event.seq <= lastSeq) return;
					lastSeq = event.seq;
					channel.event(
						"log",
						options.coded
							? {
									line: event.line,
									code: event.code ?? null,
									params: event.params ?? null,
								}
							: event.line,
						event.seq,
					);
				} else {
					channel.event("complete", {
						status: event.status,
						errorMessage: event.errorMessage,
						...(options.coded ? { error: event.error } : {}),
					});
					channel.close();
				}
			};

			try {
				await recoverOrphanedJobs();
				const live = state.jobs.get(deploymentId);
				if (live) {
					// Subscribe and snapshot in the same tick so nothing is missed;
					// live events are queued while older lines load from the DB.
					const queue: JobEvent[] = [];
					let replaying = true;
					const listener = (event: JobEvent) => {
						if (replaying) queue.push(event);
						else sendEvent(event);
					};
					const snapshot = [...live.lines];
					const done = live.done;
					if (!done) {
						live.listeners.add(listener);
						channel.onClose(() => live.listeners.delete(listener));
					}
					const firstInMemory = snapshot[0]?.seq ?? live.lastSeq + 1;
					if (lastSeq + 1 < firstInMemory) {
						for (const row of await readStoredLogs(
							deploymentId,
							lastSeq,
							firstInMemory,
						)) {
							sendEvent({ type: "log", ...row });
						}
					}
					for (const entry of snapshot) sendEvent({ type: "log", ...entry });
					replaying = false;
					for (const event of queue) sendEvent(event);
					if (done) sendEvent(done);
					return;
				}

				// Finished job: logs and final status are already persisted.
				for (const row of await readStoredLogs(deploymentId, lastSeq)) {
					sendEvent({ type: "log", ...row });
				}
				const [deployment] = await db
					.select({
						status: deployments.status,
						errorMessage: deployments.errorMessage,
						errorCode: deployments.errorCode,
						errorParams: deployments.errorParams,
						warningCount: deployments.warningCount,
					})
					.from(deployments)
					.where(eq(deployments.id, deploymentId))
					.limit(1);
				sendEvent({
					type: "done",
					status: deployment?.status === "success" ? "success" : "failed",
					errorMessage: deployment?.errorMessage ?? null,
					error: errorInfo(
						deployment?.errorMessage,
						deployment?.errorCode,
						deployment?.errorParams,
					),
				});
			} catch (error) {
				const info = errorInfoOf(error);
				channel.event("failure", {
					message: info.text,
					...(options.coded ? { error: info } : {}),
				});
				channel.close();
			}
		},
	});
}

/**
 * Audit row for a web terminal session (no logs are recorded). Terminal
 * rows don't take the server job lock.
 */
export async function recordTerminalStart(
	actor: JobOwner,
	serverId: string,
	appId?: string,
): Promise<string> {
	const type = appId ? "app_terminal" : "terminal";
	const [row] = await db
		.insert(deployments)
		.values({
			serverId,
			teamId: actor.teamId,
			userId: actor.userId,
			appId: appId ?? null,
			type,
			titleParams: {},
			title: titleFor(serverI18n(), { type, titleParams: {} }),
			status: "running",
		})
		.returning({ id: deployments.id });
	return row.id;
}

export async function recordTerminalEnd(
	deploymentId: string,
	reason: AppError | null,
): Promise<void> {
	const info = reason ? errorInfoOf(reason) : null;
	await db
		.update(deployments)
		.set({
			status: "success",
			errorMessage: info?.text ?? null,
			errorCode: info?.code ?? null,
			errorParams: info?.params ?? null,
			updatedAt: new Date(),
		})
		.where(eq(deployments.id, deploymentId));
}

/**
 * Retention of finished jobs of every kind (their logs cascade). Running
 * and pending jobs are never touched.
 */
export async function pruneOldJobs(now = new Date()): Promise<number> {
	const cutoff = new Date(
		now.getTime() - getConfig().JOB_RETENTION_DAYS * 86_400_000,
	);
	const removed = await db
		.delete(deployments)
		.where(
			and(
				inArray(deployments.status, ["success", "failed"]),
				lt(deployments.updatedAt, cutoff),
			),
		)
		.returning({ id: deployments.id });
	return removed.length;
}
