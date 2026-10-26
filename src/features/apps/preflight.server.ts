import { eq } from "drizzle-orm";
import { getConfig, hostPaths } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { domains, servers } from "#/db/schema/index.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess } from "#/features/auth/access.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { tunnelServiceUrl } from "#/features/servers/tunnel.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import {
	dryRenderNewApp,
	getTemplateManifest,
} from "#/features/templates/templates.server.ts";
import {
	evaluateLimitsCheck,
	evaluatePreflight,
	preflightScript,
	templateCheck,
} from "#/server/services/apps/preflight.ts";
import { dnsChecker } from "#/server/services/domains/checkers.ts";
import { normalizeDomainInput } from "#/server/services/domains/normalize.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import {
	parseKeyValueLines,
	probeServerOwnership,
} from "#/server/services/server-setup.ts";
import { reservedHosts, resolveServerIps } from "./apps.server";
import { serverLimitTotals, sumLimits } from "./resources.server";
import type { PreflightCheck, PreflightResult } from "./schema";

/**
 * Pre-flight for the deploy wizard: server ready, Docker/Traefik running,
 * free RAM/disk vs the template's [requirements], the domain (DNS
 * pointing at the server, not taken or reserved) and, for templates
 * rendered from upstream versions, a dry render of the chosen version and
 * inputs (version offer, policy, transform; nothing written).
 */
export async function runPreflight(
	actor: Actor,
	input: {
		templateId: string;
		serverId: string;
		domain?: string;
		version?: string;
		name?: string;
		inputs?: Record<string, string>;
	},
): Promise<PreflightResult> {
	const [server] = await db
		.select()
		.from(servers)
		.where(eq(servers.id, input.serverId))
		.limit(1);
	assertCanAccess(actor, server, "app.deploy", "SERVER_NOT_FOUND");
	const manifest = await getTemplateManifest(input.templateId);
	const requirements = {
		memoryMb: manifest.requirements.memory_mb,
		diskMb: manifest.requirements.disk_mb,
		minDockerVersion: manifest.min_docker_version ?? null,
	};
	const config = getConfig();
	const checks: PreflightCheck[] = [];
	if (server.status !== "ready") {
		checks.push({
			id: "server",
			status: "error",
			message: { code: "server_not_bootstrapped" },
		});
		return { ok: false, checks };
	}
	checks.push({
		id: "server",
		status: "ok",
		message: { code: "server_ready", params: { name: server.name } },
	});
	// Runs while the server is probed.
	const rendering = dryRenderNewApp(input).then(
		(rendered) => (rendered ? templateCheck(rendered) : null),
		(error: unknown) => templateCheck({ error }),
	);

	const executor = await getExecutor(server);
	try {
		const probe = await executor.exec(
			preflightScript(hostPaths(config).root, config.TRAEFIK_CONTAINER),
		);
		const values = parseKeyValueLines(probe.stdout);
		checks.push(...evaluatePreflight(values, requirements));
		const ownership = await probeServerOwnership(
			executor,
			await requireInstanceId(),
		);
		if (ownership.foreign.length) {
			checks.push({
				id: "owner",
				status: "error",
				message: {
					code: "server_foreign",
					params: { owner: ownership.foreign[0] },
				},
			});
		}
		// Limits of the apps already here + this template's defaults.
		const existing = await serverLimitTotals(server);
		const own = sumLimits(
			Object.values(manifest.resources).map((limits) => ({
				effective: {
					memoryMb: limits.memory_mb ?? null,
					cpus: limits.cpus ?? null,
				},
			})),
			server,
		);
		checks.push(
			evaluateLimitsCheck(
				values,
				{
					memoryMb: existing.memoryMb + own.memoryMb,
					cpus: existing.cpus + own.cpus,
				},
				config.RESOURCE_OVERCOMMIT_PERCENT,
			),
		);
	} catch (error) {
		checks.push({
			id: "docker",
			status: "error",
			message: {
				code: "probe_failed",
				params: {
					message: { $error: errorInfoOf(error) },
				},
			},
		});
	} finally {
		executor.close();
	}

	if (input.domain) {
		let host: string | null = null;
		try {
			host = normalizeDomainInput(input.domain);
		} catch {
			checks.push({
				id: "domain",
				status: "error",
				message: { code: "domain_invalid", params: { domain: input.domain } },
			});
		}
		if (host) {
			const [taken] = await db
				.select({ id: domains.id })
				.from(domains)
				.where(eq(domains.host, host))
				.limit(1);
			if (taken || (await reservedHosts()).has(host)) {
				checks.push({
					id: "domain",
					status: "error",
					message: { code: "domain_in_use", params: { host } },
				});
			} else if (server.tunnelOnly) {
				// Behind the tunnel the hostname is a CNAME to Cloudflare.
				checks.push({
					id: "domain",
					status: "ok",
					message: {
						code: "domain_tunnel",
						params: { service: tunnelServiceUrl() },
					},
				});
			} else {
				const ips = await resolveServerIps(server).catch(() => [] as string[]);
				const dns = await dnsChecker.run({
					host,
					https: true,
					serverIps: ips,
					timeoutMs: config.DOMAIN_CHECK_TIMEOUT_MS,
					expiryWarningDays: config.CERT_EXPIRY_WARNING_DAYS,
				});
				checks.push({
					id: "domain",
					// DNS can be fixed after deploying; it only blocks the certificate.
					status: dns.status === "ok" ? "ok" : "warning",
					message: dns.message,
				});
			}
		}
	} else if (server.tunnelOnly) {
		checks.push({
			id: "domain",
			status: "warning",
			message: {
				code: "domain_tunnel_free",
				params: { provider: config.FREE_DOMAIN_PROVIDER },
			},
		});
	} else {
		checks.push({
			id: "domain",
			status: "ok",
			message: {
				code: "domain_free",
				params: { provider: config.FREE_DOMAIN_PROVIDER },
			},
		});
	}
	const template = await rendering;
	if (template) checks.push(template);
	return { ok: checks.every((check) => check.status !== "error"), checks };
}
