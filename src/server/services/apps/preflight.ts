import type { PreflightCheck } from "#/features/apps/schema.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import { shellQuote } from "#/server/services/executor.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { evaluateOvercommit } from "#/server/services/templates/resources.ts";

const MIB = 1024 * 1024;

/** One round-trip: free memory/disk, Docker and Traefik state. */
export function preflightScript(
	root: string,
	traefikContainer: string,
): string {
	return [
		"echo mem_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null)",
		"echo mem_total_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)",
		"echo cpus=$(nproc 2>/dev/null)",
		`echo disk_kb=$(df -Pk ${shellQuote(root)} 2>/dev/null | awk 'NR==2 {print $4}')`,
		"echo docker=$(docker info --format '{{.ServerVersion}}' 2>/dev/null)",
		`echo traefik=$(docker inspect -f '{{.State.Running}}' ${shellQuote(traefikContainer)} 2>/dev/null)`,
	].join("\n");
}

/** Pure evaluation of the probe output against template requirements. */
export function evaluatePreflight(
	values: Record<string, string>,
	requirements: {
		memoryMb: number;
		diskMb: number;
		/** Template `min_docker_version`. */
		minDockerVersion?: string | null;
	},
): PreflightCheck[] {
	const checks: PreflightCheck[] = [];
	const docker = values.docker;
	const min = requirements.minDockerVersion;
	checks.push(
		!docker
			? { id: "docker", status: "error", message: { code: "docker_missing" } }
			: min && compareVersions(docker, min) < 0
				? {
						id: "docker",
						status: "error",
						message: {
							code: "docker_too_old",
							params: { version: docker, min },
						},
					}
				: {
						id: "docker",
						status: "ok",
						message: { code: "docker_version", params: { version: docker } },
					},
	);
	checks.push(
		values.traefik === "true"
			? { id: "traefik", status: "ok", message: { code: "traefik_running" } }
			: {
					id: "traefik",
					status: "error",
					message: { code: "traefik_not_running" },
				},
	);
	const memKb = Number(values.mem_kb);
	if (Number.isFinite(memKb) && memKb > 0) {
		const availableBytes = memKb * 1024;
		const recommendedBytes = requirements.memoryMb * MIB;
		checks.push({
			id: "memory",
			status: availableBytes >= recommendedBytes ? "ok" : "warning",
			message: { code: "memory", params: { availableBytes, recommendedBytes } },
		});
	} else {
		checks.push({
			id: "memory",
			status: "warning",
			message: { code: "memory_unknown" },
		});
	}
	const diskKb = Number(values.disk_kb);
	if (Number.isFinite(diskKb) && diskKb > 0) {
		const freeBytes = diskKb * 1024;
		const requiredBytes = requirements.diskMb * MIB;
		checks.push({
			id: "disk",
			status: freeBytes >= requiredBytes ? "ok" : "error",
			message: { code: "disk", params: { freeBytes, requiredBytes } },
		});
	} else {
		checks.push({
			id: "disk",
			status: "warning",
			message: { code: "disk_unknown" },
		});
	}
	return checks;
}

/** Numeric comparison of dotted versions (`24.0.7` vs `24.0`); suffixes ignored. */
export function compareVersions(a: string, b: string): number {
	const parts = (value: string) =>
		value
			.split(/[^0-9.]/)[0]
			.split(".")
			.map((part) => Number(part) || 0);
	const left = parts(a);
	const right = parts(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Overcommit of resource limits on the server (sum of every app's limits,
 * the new one included) against its RAM and cores. A warning only.
 */
export function evaluateLimitsCheck(
	values: Record<string, string>,
	sum: { memoryMb: number; cpus: number },
	percent: number,
): PreflightCheck {
	if (sum.memoryMb <= 0 && sum.cpus <= 0) {
		return { id: "limits", status: "ok", message: { code: "limits_none" } };
	}
	const totalKb = Number(values.mem_total_kb);
	const cores = Number(values.cpus);
	const result = evaluateOvercommit(
		sum,
		{
			memoryMb: Number.isFinite(totalKb) && totalKb > 0 ? totalKb / 1024 : null,
			cpus: Number.isFinite(cores) && cores > 0 ? cores : null,
		},
		percent,
	);
	const params = {
		limitBytes: result.memory.limitMb * MIB,
		totalBytes: (result.memory.totalMb ?? 0) * MIB,
		cpus: result.cpus.limit,
		cores: result.cpus.total ?? 0,
	};
	return result.memory.over || result.cpus.over
		? {
				id: "limits",
				status: "warning",
				message: { code: "limits_over", params },
			}
		: { id: "limits", status: "ok", message: { code: "limits_ok", params } };
}

/**
 * The `template` check from a dry render of the wizard's choices: a coded
 * refusal (version not offered, policy, invalid input) blocks the deploy
 * it would fail; anything else (GitHub unreachable, rate limit) is a
 * warning, as the deploy may still fetch the files.
 */
export function templateCheck(
	outcome: { version: string } | { error: unknown },
): PreflightCheck {
	if ("version" in outcome) {
		return {
			id: "template",
			status: "ok",
			message: { code: "template_ok", params: { version: outcome.version } },
		};
	}
	const message = { $error: errorInfoOf(outcome.error) };
	return outcome.error instanceof TemplateError
		? {
				id: "template",
				status: "error",
				message: { code: "template_refused", params: { message } },
			}
		: {
				id: "template",
				status: "warning",
				message: { code: "template_unchecked", params: { message } },
			};
}
