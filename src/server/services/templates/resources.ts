import { TemplateError } from "./naming";

/**
 * Per-service resource limits (M6). Written as `deploy.resources`, which
 * `docker compose` applies to plain containers without Swarm (verified:
 * HostConfig.Memory / NanoCpus / MemoryReservation are set). Service-level
 * `mem_limit` / `cpus` / `mem_reservation` are dropped when Nitrobase sets the
 * same limit, since compose rejects distinct values for the two forms.
 * Pure (tested).
 */
export interface ServiceResources {
	/** Hard memory limit (MiB). */
	memoryMb?: number | null;
	/** Soft reservation (MiB). */
	memoryReservationMb?: number | null;
	/** CPU limit (cores, e.g. 0.5). */
	cpus?: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const MIB = 1024 * 1024;

/** Mutates the compose service `svc` (a copy owned by the transform). */
export function applyResources(
	svc: Obj,
	resources: ServiceResources | undefined,
): void {
	if (!resources) return;
	const { memoryMb, memoryReservationMb, cpus } = resources;
	if (!memoryMb && !memoryReservationMb && !cpus) return;
	const deploy: Obj = isObj(svc.deploy) ? { ...svc.deploy } : {};
	const section: Obj = isObj(deploy.resources) ? { ...deploy.resources } : {};
	const limits: Obj = isObj(section.limits) ? { ...section.limits } : {};
	const reservations: Obj = isObj(section.reservations)
		? { ...section.reservations }
		: {};
	if (memoryMb) {
		limits.memory = `${Math.floor(memoryMb)}M`;
		delete svc.mem_limit;
		delete svc.memswap_limit;
	}
	if (cpus) {
		limits.cpus = String(cpus);
		delete svc.cpus;
	}
	if (memoryReservationMb) {
		reservations.memory = `${Math.floor(memoryReservationMb)}M`;
		delete svc.mem_reservation;
	}
	if (Object.keys(limits).length) section.limits = limits;
	if (Object.keys(reservations).length) section.reservations = reservations;
	deploy.resources = section;
	svc.deploy = deploy;
}

/** Bytes from a compose memory value (`512M`, `1g`, `134217728`). */
export function parseMemoryBytes(value: unknown): number | null {
	if (typeof value === "number") return value;
	if (typeof value !== "string") return null;
	const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i);
	if (!match) return null;
	const units: Record<string, number> = {
		"": 1,
		k: 1024,
		m: MIB,
		g: 1024 * MIB,
		t: 1024 * 1024 * MIB,
	};
	return Math.round(Number(match[1]) * units[match[2].toLowerCase()]);
}

/** Limits the compose model actually sets for a service (either form). */
export function effectiveLimits(svc: unknown): {
	memoryMb: number | null;
	cpus: number | null;
} {
	if (!isObj(svc)) return { memoryMb: null, cpus: null };
	const deploy = isObj(svc.deploy) ? svc.deploy : {};
	const section = isObj(deploy.resources) ? deploy.resources : {};
	const limits = isObj(section.limits) ? section.limits : {};
	const memory = parseMemoryBytes(limits.memory ?? svc.mem_limit);
	const cpusRaw = limits.cpus ?? svc.cpus;
	const cpus =
		cpusRaw === undefined || cpusRaw === null ? null : Number(cpusRaw);
	return {
		memoryMb: memory ? memory / MIB : null,
		cpus: cpus && Number.isFinite(cpus) && cpus > 0 ? cpus : null,
	};
}

/**
 * Policy (raw and resolved model): every limit Nitrobase set is present and
 * not looser than configured. Template/upstream limits are never removed.
 */
export function assertResources(
	services: Record<string, unknown>,
	expected: Record<string, ServiceResources> | undefined,
): void {
	for (const [name, resources] of Object.entries(expected ?? {})) {
		if (!(name in services)) continue;
		const actual = effectiveLimits(services[name]);
		if (
			resources.memoryMb &&
			(!actual.memoryMb || actual.memoryMb > resources.memoryMb + 0.5)
		) {
			throw new TemplateError("RESOURCES_MEMORY_MISMATCH", {
				service: name,
				memory: resources.memoryMb ?? 0,
			});
		}
		if (
			resources.cpus &&
			(!actual.cpus || actual.cpus > resources.cpus + 1e-6)
		) {
			throw new TemplateError("RESOURCES_CPU_MISMATCH", {
				service: name,
				cpus: resources.cpus ?? 0,
			});
		}
	}
}

/**
 * Effective limits per service: template defaults, then the app's
 * overrides (`null` = no Nitrobase limit). Only known services.
 */
export function mergeResources(
	services: string[],
	defaults: Record<string, ServiceResources> | undefined,
	overrides: Record<string, ServiceResources> | undefined,
): Record<string, ServiceResources> {
	const out: Record<string, ServiceResources> = {};
	for (const service of services) {
		const base = defaults?.[service] ?? {};
		const own = overrides?.[service] ?? {};
		const pick = <K extends keyof ServiceResources>(key: K) =>
			key in own ? own[key] : base[key];
		const merged: ServiceResources = {
			memoryMb: pick("memoryMb") ?? null,
			memoryReservationMb: pick("memoryReservationMb") ?? null,
			cpus: pick("cpus") ?? null,
		};
		if (merged.memoryMb || merged.cpus || merged.memoryReservationMb) {
			out[service] = merged;
		}
	}
	return out;
}

export interface OvercommitResult {
	/** Sum of memory limits vs RAM (MiB); null when unknown. */
	memory: { limitMb: number; totalMb: number | null; over: boolean };
	cpus: { limit: number; total: number | null; over: boolean };
}

/**
 * Pre-flight overcommit: the sum of limits on a server against its RAM and
 * cores (`percent` of capacity). Limits are caps, not reservations, so an
 * overcommit is a warning, not an error.
 */
export function evaluateOvercommit(
	sum: { memoryMb: number; cpus: number },
	capacity: { memoryMb: number | null; cpus: number | null },
	percent: number,
): OvercommitResult {
	const ratio = percent / 100;
	return {
		memory: {
			limitMb: Math.round(sum.memoryMb),
			totalMb:
				capacity.memoryMb === null ? null : Math.round(capacity.memoryMb),
			over:
				capacity.memoryMb !== null && sum.memoryMb > capacity.memoryMb * ratio,
		},
		cpus: {
			limit: Math.round(sum.cpus * 100) / 100,
			total: capacity.cpus,
			over: capacity.cpus !== null && sum.cpus > capacity.cpus * ratio,
		},
	};
}
