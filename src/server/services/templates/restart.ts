import { parse as parseYaml } from "yaml";
import {
	type RestartPolicy,
	restartPolicies,
	restartPolicyOf,
} from "#/config/restart-policies.ts";

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `deploy.restart_policy.condition` → the matching `restart:` policy. */
const DEPLOY_CONDITIONS: Record<string, RestartPolicy> = {
	none: "no",
	"on-failure": "on-failure",
	any: "always",
};

/**
 * The restart policy a service declares (`restart:` or
 * `deploy.restart_policy`), or undefined when it declares none.
 */
export function declaredRestart(service: unknown): RestartPolicy | undefined {
	if (!isObj(service)) return undefined;
	if (service.restart !== undefined && service.restart !== null) {
		// An unknown value is still a choice: keep it as "no default".
		return restartPolicyOf(service.restart) ?? "no";
	}
	const deploy = isObj(service.deploy) ? service.deploy : undefined;
	const policy = isObj(deploy?.restart_policy)
		? deploy.restart_policy
		: undefined;
	if (!policy) return undefined;
	return DEPLOY_CONDITIONS[String(policy.condition ?? "any")] ?? "always";
}

/** Parent of a service through `extends` in the same file, if any. */
function extendsParent(service: unknown): string | undefined {
	if (!isObj(service)) return undefined;
	const ref = service.extends;
	if (typeof ref === "string") return ref;
	// `extends.file` (another file) is refused by the compose policy.
	if (isObj(ref) && ref.file === undefined && typeof ref.service === "string")
		return ref.service;
	return undefined;
}

/**
 * The restart policy `name` ends up with: its own, else the one it
 * inherits through same-file `extends` (Compose merges the parent in),
 * else undefined.
 */
export function resolvedRestart(
	services: Obj,
	name: string,
): RestartPolicy | undefined {
	const seen = new Set<string>();
	let current: string | undefined = name;
	while (current !== undefined && !seen.has(current)) {
		seen.add(current);
		const service: unknown = services[current];
		const policy = declaredRestart(service);
		if (policy) return policy;
		current = extendsParent(service);
	}
	return undefined;
}

/**
 * Services another service waits on to finish
 * (`depends_on: { x: { condition: service_completed_successfully } }`):
 * one-shot jobs such as migrations.
 */
export function completionTargets(services: Obj): Set<string> {
	const out = new Set<string>();
	for (const service of Object.values(services)) {
		if (!isObj(service) || !isObj(service.depends_on)) continue;
		for (const [target, spec] of Object.entries(service.depends_on)) {
			if (isObj(spec) && spec.condition === "service_completed_successfully") {
				out.add(target);
			}
		}
	}
	return out;
}

/**
 * Services allowed to exit 0 and stay stopped: waited on to finish, or
 * under a policy (or none) that leaves a clean exit stopped. Any other
 * service of a running app is expected to run.
 */
export function oneShotServices(services: Obj): Set<string> {
	const out = completionTargets(services);
	for (const name of Object.keys(services)) {
		const policy = resolvedRestart(services, name);
		if (!policy || !restartPolicies[policy].clean) out.add(name);
	}
	return out;
}

/**
 * `oneShotServices` of a deployed compose file (YAML text or model);
 * empty when there is none or it does not parse.
 */
export function oneShotServicesOf(compose: unknown): Set<string> {
	const services = servicesOf(compose);
	return services ? oneShotServices(services) : new Set();
}

/**
 * Services that may have no container at all: profile-gated (Nitrobase
 * activates no profile; a template's `COMPOSE_PROFILES` may) or scaled to
 * 0 (`scale: 0`, `deploy.replicas: 0`).
 */
function optionalServices(services: Obj): Set<string> {
	const out = new Set<string>();
	for (const [name, service] of Object.entries(services)) {
		if (!isObj(service)) continue;
		const deploy = isObj(service.deploy) ? service.deploy : undefined;
		if (
			(Array.isArray(service.profiles) && service.profiles.length > 0) ||
			Number(service.scale) === 0 ||
			Number(deploy?.replicas) === 0
		) {
			out.add(name);
		}
	}
	return out;
}

function servicesOf(compose: unknown): Obj | undefined {
	let model = compose;
	if (typeof compose === "string") {
		try {
			model = parseYaml(compose);
		} catch {
			return undefined;
		}
	}
	return isObj(model) && isObj(model.services) ? model.services : undefined;
}

/** `optionalServices` of a deployed compose file (YAML text or model). */
export function optionalServicesOf(compose: unknown): Set<string> {
	const services = servicesOf(compose);
	return services ? optionalServices(services) : new Set();
}

/**
 * Services of a deployed compose file that a deploy today would give
 * `policy` (deployed before the default existed, BUG-015): until a
 * redeploy, a reboot of the host leaves them stopped.
 */
export function restartPolicyPending(
	compose: unknown,
	policy: RestartPolicy | undefined,
	keep: readonly string[] = [],
): string[] {
	const services = servicesOf(compose);
	if (!services || !policy) return [];
	const copy = structuredClone(services) as Record<string, Obj>;
	return applyDefaultRestart(copy, { policy, keep });
}

export interface DefaultRestart {
	/** Policy given to services that declare none. */
	policy: RestartPolicy;
	/** Services left without one (template `no_default_restart`). */
	keep?: readonly string[];
}

/**
 * Give every service that declares no restart policy the default (in
 * place), so a reboot of the host brings the whole app back. Left alone:
 * services with an explicit `restart:` (also `"no"`) or
 * `deploy.restart_policy`, own or inherited through same-file `extends`,
 * one-shot jobs other services wait on to finish,
 * and the services the template keeps. Returns the services changed.
 */
export function applyDefaultRestart(
	services: Record<string, Obj>,
	defaults: DefaultRestart | undefined,
): string[] {
	if (!defaults) return [];
	const keep = new Set(defaults.keep ?? []);
	const oneShot = completionTargets(services);
	const changed: string[] = [];
	// Decide on the input first: a parent given the default would hide
	// what its children inherit.
	const missing = Object.keys(services).filter(
		(name) =>
			!keep.has(name) && !oneShot.has(name) && !resolvedRestart(services, name),
	);
	for (const name of missing) {
		const service = services[name];
		if (!service) continue;
		service.restart = defaults.policy;
		changed.push(name);
	}
	return changed;
}
