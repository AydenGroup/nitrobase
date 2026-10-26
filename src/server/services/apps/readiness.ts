import type { ServiceStatus } from "./commands";

/**
 * Deploy readiness over time (pure, tested). One `docker inspect` sample
 * is not enough: a crash-looping container alternates `restarting` and
 * `running`, and a sample that lands on `running` looked ready. The
 * tracker calls the app ready only when every service stayed ready, with
 * no new restart, for several consecutive samples spanning a minimum time,
 * and fails it when a service keeps restarting.
 *
 * Restarts are counted against the limit only from the first sample in
 * which every service is up at once (running and not `starting` or
 * unhealthy, or exited 0 for one-shot services): on a first boot services
 * that depend on a database still initialising restart a few times by
 * design (`restart: unless-stopped` as their retry loop), and such a
 * service is briefly `running` between its attempts, so "seen running
 * once" per service would not mean the stack has booted. Before that
 * point only a much higher backstop (`BOOT_RESTART_FACTOR` × the limit)
 * fails the wait, so a service that keeps crashing while the rest never
 * comes up does not keep the deploy waiting until its timeout.
 *
 * A healthcheck that reports `unhealthy` once is not a failure yet: Docker
 * marks a container unhealthy after its start period plus `retries` failed
 * checks, and a slow-booting service flips back to healthy on the next
 * passing check. A service fails as unhealthy only when it stays so (same
 * container, no restart in between) for `unhealthyGraceMs` and at least
 * `unhealthySamples` consecutive samples; `dead` fails at once.
 */

export interface ReadinessSettings {
	/** Restarts after every service was up that fail the wait (crash loop). */
	restartLimit: number;
	/** Every service ready, without a restart, for at least this long... */
	stableMs: number;
	/** ...and over at least this many consecutive samples. */
	stableSamples: number;
	/** A service unhealthy for at least this long... */
	unhealthyGraceMs: number;
	/** ...and over at least this many consecutive samples fails the wait. */
	unhealthySamples: number;
}

/** Restarts before every service was up that fail the wait: limit × this. */
const BOOT_RESTART_FACTOR = 3;

type ReadinessFailure =
	| { kind: "restart_loop"; service: string; restarts: number }
	| { kind: "unhealthy" };

export type ReadinessVerdict =
	| { state: "pending" | "ready"; detail: string }
	| { state: "failed"; detail: string; failure: ReadinessFailure };

type ServiceClass =
	| "ready"
	| "pending"
	| "unhealthy"
	| "failed"
	| "exited_error";

function classify(status: ServiceStatus): ServiceClass {
	if (status.state === "dead") return "failed";
	if (status.health === "unhealthy") return "unhealthy";
	if (status.state === "exited") {
		// One-shot services (migrations) exit 0 when done.
		return status.exitCode === 0 ? "ready" : "exited_error";
	}
	if (status.state !== "running") return "pending"; // created, restarting...
	return status.health === "starting" ? "pending" : "ready";
}

/** `svc=state[/health][(exit)][ ↻restarts]` per service, for the job log. */
function describe(status: ServiceStatus, delta: number): string {
	const health = status.health ? `/${status.health}` : "";
	const exit =
		status.state === "exited" && status.exitCode !== null
			? `(${status.exitCode})`
			: "";
	const restarts = delta > 0 ? ` ↻${delta}` : "";
	return `${status.service}=${status.state}${health}${exit}${restarts}`;
}

/** Restart counts from a baseline (re-based when a container is recreated). */
class RestartCounter {
	private readonly base = new Map<string, number>();

	delta(status: ServiceStatus): number {
		if (status.restarts === null) return 0;
		const base = this.base.get(status.service);
		if (base === undefined || status.restarts < base) {
			this.base.set(status.service, status.restarts);
			return 0;
		}
		return status.restarts - base;
	}

	reset(statuses: ServiceStatus[]): void {
		this.base.clear();
		for (const status of statuses) this.delta(status);
	}

	since(status: ServiceStatus): number {
		const base = this.base.get(status.service);
		if (status.restarts === null || base === undefined) return 0;
		return Math.max(0, status.restarts - base);
	}
}

/**
 * Whether monitoring saw every deployed service up: each one has a
 * (recent) sample that is running and neither unhealthy nor starting. A
 * service without a sample (container gone, not sampled yet) is not.
 */
export function allServicesHealthy(
	services: readonly string[],
	samples: readonly {
		service: string | null;
		state: string | null;
		health: string | null;
	}[],
): boolean {
	return (
		services.length > 0 &&
		services.every((service) => {
			const own = samples.filter((sample) => sample.service === service);
			return (
				own.length > 0 &&
				own.every(
					(sample) =>
						sample.state === "running" &&
						sample.health !== "unhealthy" &&
						sample.health !== "starting",
				)
			);
		})
	);
}

/** Services left out of `serviceRunState`, from the deployed compose file. */
export interface ServiceRunExpectations {
	/** May exit 0 and stay stopped (`oneShotServices`). */
	oneShot?: ReadonlySet<string>;
	/** May have no container (profile-gated, scaled to 0). */
	optional?: ReadonlySet<string>;
	/** Stopped one by one by the owner (app inputs `stoppedServices`). */
	stopped?: ReadonlySet<string>;
}

/**
 * Long-running services of an app without a running container in
 * `samples` (BUG-015). `notRunning`: a container exists but is stopped
 * or restarting (Start brings it back; the app is partially running).
 * `missing`: no container at all although one is expected (only a
 * redeploy creates it). One-shot, optional and owner-stopped services are
 * never listed.
 */
export function serviceRunState(
	services: readonly string[],
	samples: readonly { service: string | null; state: string | null }[],
	expected: ServiceRunExpectations = {},
): { notRunning: string[]; missing: string[] } {
	const notRunning: string[] = [];
	const missing: string[] = [];
	for (const service of services) {
		if (expected.oneShot?.has(service) || expected.stopped?.has(service)) {
			continue;
		}
		const own = samples.filter((sample) => sample.service === service);
		if (own.length === 0) {
			if (!expected.optional?.has(service)) missing.push(service);
		} else if (!own.some((sample) => sample.state === "running")) {
			notRunning.push(service);
		}
	}
	return { notRunning, missing };
}

export class ReadinessTracker {
	/** From each service's first sample (job log, boot backstop). */
	private readonly total = new RestartCounter();
	/** From the first sample where every service was up at once. */
	private readonly counted = new RestartCounter();
	private counting = false;
	/** Restart counts and states of the previous sample. */
	private previous = new Map<string, ServiceStatus>();
	private windowStart: number | null = null;
	private windowSamples = 0;
	/** Per service: since when (and over how many samples) it is unhealthy. */
	private unhealthy = new Map<
		string,
		{ since: number; samples: number; restarts: number | null }
	>();

	constructor(private readonly settings: ReadinessSettings) {}

	/** Whether restarts count against the limit yet (every service was up at once). */
	get countingRestarts(): boolean {
		return this.counting;
	}

	/** Whether a service was unhealthy in the last sample (still in grace). */
	get unhealthyNow(): boolean {
		return this.unhealthy.size > 0;
	}

	/**
	 * Track the unhealthy streak of each service; true when one stayed
	 * unhealthy past the grace window. A restart (new container start)
	 * or any other state starts the streak over.
	 */
	private unhealthyExpired(statuses: ServiceStatus[], now: number): boolean {
		const streaks = new Map<
			string,
			{ since: number; samples: number; restarts: number | null }
		>();
		let expired = false;
		for (const status of statuses) {
			if (classify(status) !== "unhealthy") continue;
			const before = this.unhealthy.get(status.service);
			const streak =
				before && before.restarts === status.restarts
					? { ...before, samples: before.samples + 1 }
					: { since: now, samples: 1, restarts: status.restarts };
			streaks.set(status.service, streak);
			if (
				streak.samples >= Math.max(1, this.settings.unhealthySamples) &&
				now - streak.since >= this.settings.unhealthyGraceMs
			) {
				expired = true;
			}
		}
		this.unhealthy = streaks;
		return expired;
	}

	observe(statuses: ServiceStatus[], now: number): ReadinessVerdict {
		const totals = new Map(
			statuses.map((status) => [status.service, this.total.delta(status)]),
		);
		if (
			!this.counting &&
			statuses.length > 0 &&
			statuses.every((status) => classify(status) === "ready")
		) {
			this.counting = true;
			this.counted.reset(statuses);
		}
		const detail = statuses
			.map((status) => describe(status, totals.get(status.service) ?? 0))
			.join(", ");
		const previous = this.previous;
		this.previous = new Map(statuses.map((status) => [status.service, status]));

		const limit = this.counting
			? this.settings.restartLimit
			: this.settings.restartLimit * BOOT_RESTART_FACTOR;
		let loop: { service: string; restarts: number } | null = null;
		for (const status of statuses) {
			const restarts = this.counting
				? this.counted.delta(status)
				: (totals.get(status.service) ?? 0);
			if (restarts >= limit && restarts > (loop?.restarts ?? 0)) {
				loop = { service: status.service, restarts };
			}
		}
		if (loop) {
			return {
				state: "failed",
				detail,
				failure: { kind: "restart_loop", ...loop },
			};
		}

		if (this.unhealthyExpired(statuses, now)) {
			return { state: "failed", detail, failure: { kind: "unhealthy" } };
		}
		let allReady = statuses.length > 0;
		for (const status of statuses) {
			const kind = classify(status);
			if (kind === "failed") {
				return { state: "failed", detail, failure: { kind: "unhealthy" } };
			}
			if (kind === "exited_error") {
				// Failed when it stays exited (no restart) for two samples:
				// a container being restarted may be seen exited once.
				const before = previous.get(status.service);
				if (
					before?.state === "exited" &&
					before.exitCode === status.exitCode &&
					before.restarts === status.restarts
				) {
					return { state: "failed", detail, failure: { kind: "unhealthy" } };
				}
			}
			if (kind !== "ready") allReady = false;
		}

		// Stable: same services, all ready, no restart since the last sample.
		const unchanged =
			previous.size === statuses.length &&
			statuses.every(
				(status) =>
					previous.has(status.service) &&
					previous.get(status.service)?.restarts === status.restarts,
			);
		if (!allReady) {
			this.windowStart = null;
			this.windowSamples = 0;
		} else if (this.windowStart === null || !unchanged) {
			this.windowStart = now;
			this.windowSamples = 1;
		} else {
			this.windowSamples += 1;
		}
		const ready =
			this.windowStart !== null &&
			this.windowSamples >= Math.max(1, this.settings.stableSamples) &&
			now - this.windowStart >= this.settings.stableMs;
		return { state: ready ? "ready" : "pending", detail };
	}

	/**
	 * Restarts per service during the wait: `boot` before every service
	 * was up (expected while dependencies initialise), `after` since.
	 */
	restarts(): { service: string; boot: number; after: number }[] {
		const out: { service: string; boot: number; after: number }[] = [];
		for (const status of this.previous.values()) {
			const total = this.total.since(status);
			const after = this.counting ? this.counted.since(status) : 0;
			if (total > 0) {
				out.push({
					service: status.service,
					boot: Math.max(0, total - after),
					after,
				});
			}
		}
		return out.sort((a, b) => a.service.localeCompare(b.service));
	}

	/** Services that restarted after every service was up (the warning). */
	restarted(): { service: string; restarts: number }[] {
		return this.restarts()
			.filter((item) => item.after > 0)
			.map(({ service, after }) => ({ service, restarts: after }));
	}
}
