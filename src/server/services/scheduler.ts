import { Cron } from "croner";
import { APP_ID } from "#/config/shared.ts";

type ScheduledTask = () => Promise<void> | void;

interface SchedulerState {
	jobs: Map<string, Cron>;
}

// On globalThis so dev HMR reloads replace jobs instead of duplicating them.
const globalScheduler = globalThis as typeof globalThis & {
	__nitrobaseScheduler?: SchedulerState;
};
globalScheduler.__nitrobaseScheduler ??= { jobs: new Map() };
const state: SchedulerState = globalScheduler.__nitrobaseScheduler;

/**
 * Register (or replace) a named in-process cron task. Runs never overlap:
 * a tick is skipped while the previous run is still going. Errors are
 * logged, never thrown into the timer.
 */
export function schedule(
	name: string,
	pattern: string,
	task: ScheduledTask,
): Cron {
	unschedule(name);
	const job = new Cron(
		pattern,
		{
			name: `${APP_ID}:${name}`,
			protect: true,
			unref: true,
			catch: (error) => {
				console.error(`[scheduler] ${name} failed`, error);
			},
		},
		task,
	);
	state.jobs.set(name, job);
	return job;
}

export function unschedule(name: string): boolean {
	const job = state.jobs.get(name);
	if (!job) return false;
	job.stop();
	state.jobs.delete(name);
	return true;
}

export function stopScheduler(): void {
	for (const name of [...state.jobs.keys()]) unschedule(name);
}
