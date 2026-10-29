/**
 * Compose `restart:` policies (`on-failure:<n>` reads as `on-failure`).
 * `clean`: Docker starts the container again after it exits 0, and after
 * the Docker daemon (or the host) restarts. Without it, a container that
 * stopped stays stopped: one-shot jobs (migrations, init) rely on that.
 * `keepsStop`: a container stopped by hand (Stop in the panel) stays stopped
 * after the daemon or the host restarts. `always` starts it again.
 */
export const restartPolicies = {
	no: { clean: false, keepsStop: true },
	"on-failure": { clean: false, keepsStop: true },
	always: { clean: true, keepsStop: false },
	"unless-stopped": { clean: true, keepsStop: true },
} as const satisfies Record<string, { clean: boolean; keepsStop: boolean }>;

export type RestartPolicy = keyof typeof restartPolicies;

export const RESTART_POLICIES = Object.keys(restartPolicies) as [
	RestartPolicy,
	...RestartPolicy[],
];

/** `APP_DEFAULT_RESTART` value that turns the default off. */
export const NO_DEFAULT_RESTART = "none";

/** The default policy an `APP_DEFAULT_RESTART` value sets (none: off). */
export function defaultRestartOf(
	value: RestartPolicy | typeof NO_DEFAULT_RESTART,
): RestartPolicy | undefined {
	return value === NO_DEFAULT_RESTART ? undefined : value;
}

/** Base policy of a compose `restart:` value; undefined when unknown. */
export function restartPolicyOf(value: unknown): RestartPolicy | undefined {
	if (value === false) return "no";
	if (typeof value !== "string") return undefined;
	const base = value.trim().split(":")[0] ?? "";
	return base in restartPolicies ? (base as RestartPolicy) : undefined;
}
