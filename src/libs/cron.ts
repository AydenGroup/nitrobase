import { Cron } from "croner";

/**
 * Cron helpers shared by the scheduler, backups, tasks and the schedule
 * forms (pure, client-safe: croner runs in the browser too). Every
 * schedule runs in the scheduler's time zone (`schedulerClock`).
 */

/** The next tick of `cron` (null: invalid or no future tick). */
export function nextRunAt(
	cron: string,
	options: { timezone?: string; after?: Date } = {},
): Date | null {
	try {
		return new Cron(cron, { paused: true, timezone: options.timezone }).nextRun(
			options.after,
		);
	} catch {
		return null;
	}
}

/** Time zone of the in-process scheduler (IANA name + current UTC offset). */
export function schedulerClock(now = new Date()): {
	timeZone: string;
	offsetMinutes: number;
} {
	return {
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		offsetMinutes: -now.getTimezoneOffset(),
	};
}

export type SchedulePreset = "daily" | "weekly" | "custom";

/** A schedule as the form edits it: a preset at an hour, or custom cron. */
export interface ScheduleChoice {
	preset: SchedulePreset;
	hour: number;
	weekday: number;
}

/** Cron → form choice (daily/weekly at a given hour, else custom). */
export function parseSchedule(
	cron: string,
	fallback: Omit<ScheduleChoice, "preset"> = { hour: 3, weekday: 0 },
): ScheduleChoice {
	const daily = /^0 (\d{1,2}) \* \* \*$/.exec(cron);
	if (daily) return { preset: "daily", hour: Number(daily[1]), weekday: 0 };
	const weekly = /^0 (\d{1,2}) \* \* (\d)$/.exec(cron);
	if (weekly) {
		return {
			preset: "weekly",
			hour: Number(weekly[1]),
			weekday: Number(weekly[2]),
		};
	}
	return { preset: "custom", ...fallback };
}

/** Form choice → cron (`custom` as typed). */
export function buildSchedule(choice: ScheduleChoice, custom: string): string {
	if (choice.preset === "daily") return `0 ${choice.hour} * * *`;
	if (choice.preset === "weekly") {
		return `0 ${choice.hour} * * ${choice.weekday}`;
	}
	return custom.trim();
}

/**
 * Catch-up: a run is missed when the schedule had a tick between the last
 * run (or the policy's creation) and now that never ran, e.g. while
 * the panel was down. Pure (cron evaluated from the given dates).
 */
export function missedRunAt(input: {
	cron: string;
	lastRunAt: Date | null;
	createdAt: Date;
	now: Date;
	timezone?: string;
}): Date | null {
	const since = input.lastRunAt ?? input.createdAt;
	const next = new Cron(input.cron, {
		paused: true,
		timezone: input.timezone,
	}).nextRun(since);
	return next && next.getTime() < input.now.getTime() ? next : null;
}

export function isValidCron(pattern: string): boolean {
	try {
		const cron = new Cron(pattern, { paused: true });
		return cron.nextRun() !== null;
	} catch {
		return false;
	}
}

/** Minimum minutes between two ticks (rejects every-minute style schedules). */
export function minIntervalMinutes(pattern: string, samples = 5): number {
	const cron = new Cron(pattern, { paused: true });
	const runs = cron.nextRuns(samples);
	let min = Number.POSITIVE_INFINITY;
	for (let i = 1; i < runs.length; i++) {
		min = Math.min(min, (runs[i].getTime() - runs[i - 1].getTime()) / 60000);
	}
	return min;
}
