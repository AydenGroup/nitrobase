const MIB = 1024 * 1024;

/** First line of `composeOomCommand`: the host's clock (epoch seconds). */
export const OOM_NOW_PREFIX = "now";

export interface OomKill {
	service: string;
	/** The memory limit the container was killed under (MiB). */
	limitMb: number;
}

export interface OomKillOptions {
	/**
	 * Only kills whose container stopped at most this many seconds before
	 * the host's clock (the `now` line): `State.OOMKilled` describes the
	 * container's last exit and stays true until it exits again or is
	 * recreated, so an old kill must not explain today's failure. Unknown
	 * times (no `now` line, unreadable `FinishedAt`) keep the kill: a hint
	 * is advice and never replaces the failure it explains.
	 */
	withinSeconds?: number;
}

/** Docker's RFC 3339 time with nanoseconds, as epoch seconds (null: unknown). */
function epochSeconds(value: string | undefined): number | null {
	if (!value) return null;
	const ms = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
	// Docker's zero time (never finished) is year 1.
	return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
}

/**
 * Services with a container the kernel killed for memory under a limit,
 * from `composeOomCommand`'s rows
 * (`service<TAB>OOMKilled<TAB>limit bytes<TAB>FinishedAt`).
 * A kill without a limit is the host running out, not the app's limit:
 * the advice (raise the limit) would not apply, so it is skipped.
 */
export function parseOomKills(
	output: string,
	options: OomKillOptions = {},
): OomKill[] {
	const lines = output.split("\n").map((line) => line.trim());
	let now: number | null = null;
	for (const line of lines) {
		const [prefix, value] = line.split("\t");
		if (prefix === OOM_NOW_PREFIX && /^\d+$/.test(value ?? "")) {
			now = Number(value);
		}
	}
	const kills = new Map<string, OomKill>();
	for (const line of lines) {
		const [service, killed, bytes, finishedAt] = line.split("\t");
		if (!service || killed !== "true") continue;
		const limit = Number(bytes);
		if (!Number.isFinite(limit) || limit <= 0) continue;
		const finished = epochSeconds(finishedAt);
		if (
			options.withinSeconds !== undefined &&
			now !== null &&
			finished !== null &&
			finished < now - options.withinSeconds
		) {
			continue;
		}
		if (!kills.has(service)) {
			kills.set(service, { service, limitMb: Math.round(limit / MIB) });
		}
	}
	return [...kills.values()];
}
