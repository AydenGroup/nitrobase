/**
 * Dependents to restart after `compose up` (BUG-023). Compose recreates a
 * service whose config changed (e.g. a new memory limit on `postgresql`)
 * but leaves the services that depend on it running: they keep their
 * connections to the old container and fail on first use. Which services
 * `up` recreated or (re)started is read from the containers themselves (id
 * and start time before and after `up`), so only the running dependents of
 * those, transitively through `depends_on`, are restarted, never the
 * whole app. Pure, so the choice is unit-tested.
 */

/** One container of a service, as `composeIdentityCommand` prints it. */
export interface ContainerIdentity {
	id: string;
	startedAt: string;
	state: string;
}

/** Service -> its containers (replicas), sorted by id. */
export type ProjectIdentities = Map<string, ContainerIdentity[]>;

/** Lines of `composeIdentityCommand`. */
export function parseContainerIdentities(output: string): ProjectIdentities {
	const out: ProjectIdentities = new Map();
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const [service = "", id = "", startedAt = "", state = ""] = line
			.split("\t")
			.map((part) => part.trim());
		if (!service || service === "<no value>" || !id) continue;
		const list = out.get(service) ?? [];
		list.push({ id, startedAt, state });
		out.set(service, list);
	}
	for (const list of out.values())
		list.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}

/**
 * Compose service -> services it `depends_on` (list or map form).
 * `runtimeOnly` leaves out one-shot jobs waited on to finish
 * (`condition: service_completed_successfully`): a dependent holds no
 * connection to them, and `up` runs them again on every deploy.
 */
export function composeDependsOn(
	model: unknown,
	options: { runtimeOnly?: boolean } = {},
): Record<string, string[]> {
	const services = (model as { services?: Record<string, unknown> })?.services;
	return Object.fromEntries(
		Object.entries(services ?? {}).map(([name, service]) => {
			const dependsOn = (service as { depends_on?: unknown } | null)
				?.depends_on;
			const targets = Array.isArray(dependsOn)
				? dependsOn.filter((item): item is string => typeof item === "string")
				: dependsOn && typeof dependsOn === "object"
					? Object.entries(dependsOn as Record<string, unknown>)
							.filter(
								([, spec]) =>
									!options.runtimeOnly ||
									(spec as { condition?: unknown } | null)?.condition !==
										"service_completed_successfully",
							)
							.map(([target]) => target)
					: [];
			return [name, targets];
		}),
	);
}

const fingerprint = (list: ContainerIdentity[] | undefined) =>
	(list ?? []).map((item) => `${item.id}@${item.startedAt}`).join(",");

const allRunning = (list: ContainerIdentity[] | undefined) =>
	!!list?.length && list.every((item) => item.state === "running");

/**
 * Services to restart after `up`: running before and after `up` with the
 * same containers (`up` left them alone), that depend, directly or
 * through other services, on a service whose containers `up` recreated or
 * (re)started. A first deploy (nothing before) restarts nothing; neither
 * does a service compose itself restarted (`depends_on.restart`). Sorted
 * dependencies first (compose orders the restart by `depends_on` too).
 */
export function dependentsToRestart(input: {
	before: ProjectIdentities;
	after: ProjectIdentities;
	dependsOn: Record<string, string[]>;
}): {
	/** Services to restart, dependencies first. */
	restart: string[];
	/** The recreated or (re)started services they depend on. */
	changed: string[];
} {
	const { before, after, dependsOn } = input;
	const changed = new Set(
		[...after.keys()].filter(
			(service) =>
				fingerprint(before.get(service)) !== fingerprint(after.get(service)),
		),
	);
	// Only a running new container is one to reconnect to (a one-shot `up`
	// ran again and that has exited is not).
	const causesRestart = (service: string) =>
		changed.has(service) && allRunning(after.get(service));
	// Changed services `service` depends on, directly or transitively.
	const reached = (service: string): Set<string> => {
		const found = new Set<string>();
		const seen = new Set<string>();
		const walk = (current: string) => {
			if (seen.has(current)) return; // visited, or a cycle
			seen.add(current);
			for (const target of dependsOn[current] ?? []) {
				// A recreated service reconnected to what it depends on.
				if (causesRestart(target)) found.add(target);
				else walk(target);
			}
		};
		walk(service);
		return found;
	};
	const restart: string[] = [];
	const causes = new Set<string>();
	for (const service of after.keys()) {
		if (changed.has(service)) continue;
		if (!allRunning(before.get(service)) || !allRunning(after.get(service))) {
			continue;
		}
		const found = reached(service);
		if (found.size === 0) continue;
		restart.push(service);
		for (const cause of found) causes.add(cause);
	}
	return {
		restart: orderByDependencies(restart, dependsOn),
		changed: orderByDependencies([...causes], dependsOn),
	};
}

/** `services` with dependencies before dependents (name order as tiebreak). */
function orderByDependencies(
	services: string[],
	dependsOn: Record<string, string[]>,
): string[] {
	const wanted = new Set(services);
	const seen = new Set<string>();
	const out: string[] = [];
	const visit = (service: string) => {
		if (seen.has(service)) return;
		seen.add(service);
		for (const target of dependsOn[service] ?? []) visit(target);
		if (wanted.has(service)) out.push(service);
	};
	for (const service of [...services].sort()) visit(service);
	return out;
}
