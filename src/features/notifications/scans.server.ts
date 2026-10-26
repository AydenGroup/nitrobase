import { and, desc, eq, gt, isNotNull, lt } from "drizzle-orm";
import { renderCheckDetail } from "#/config/check-details.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps, domains } from "#/db/schema/apps.ts";
import { backupPolicies, backups } from "#/db/schema/backups.ts";
import { auditEvents } from "#/db/schema/platform.ts";
import { servers } from "#/db/schema/server.ts";
import { resolveServerIps } from "#/features/apps/apps.server.ts";
import {
	runDomainChecks,
	tunnelCheckInput,
} from "#/features/apps/domains.server.ts";
import { pruneRateLimits } from "#/features/auth/rate-limits.server.ts";
import { pruneSessions } from "#/features/auth/sessions.server.ts";
import { pruneOldJobs } from "#/features/deployments/deployments.server.ts";
import { emitEvent } from "#/server/services/events/bus.ts";
import { schedule } from "#/server/services/scheduler.ts";
import { pruneDeliveries } from "./dispatcher.server";
import { notificationI18n } from "./i18n.server";

/** Checker id → events for its warning/error results. */
const certEvents: Record<string, { warning?: string; error?: string }> = {
	cert: { warning: "cert.expiring", error: "cert.error" },
};

/**
 * Scheduled scan of every domain with the domain checker registry; cert
 * warnings/errors become events (deduped per host by the dispatcher).
 */
async function runCertScan(): Promise<void> {
	const rows = await db
		.select({ domain: domains, app: apps, server: servers })
		.from(domains)
		.innerJoin(apps, eq(apps.id, domains.appId))
		.innerJoin(servers, eq(servers.id, apps.serverId))
		.where(eq(servers.status, "ready"));
	const ipsByServer = new Map<string, string[]>();
	const tunnelByServer = new Map<
		string,
		Awaited<ReturnType<typeof tunnelCheckInput>>
	>();
	for (const { domain, app, server } of rows) {
		try {
			if (!ipsByServer.has(server.id)) {
				ipsByServer.set(
					server.id,
					await resolveServerIps(server).catch(() => []),
				);
			}
			if (
				!tunnelByServer.has(server.id) &&
				(server.tunnelOnly || domain.viaTunnel)
			) {
				tunnelByServer.set(
					server.id,
					await tunnelCheckInput(server, [{ viaTunnel: true }]),
				);
			}
			const checks = await runDomainChecks(
				domain,
				ipsByServer.get(server.id) ?? [],
				tunnelByServer.get(server.id) ?? {
					only: server.tunnelOnly,
					enabled: server.tunnelEnabled,
				},
			);
			for (const [checker, events] of Object.entries(certEvents)) {
				const result = checks[checker];
				const id =
					result?.status === "error"
						? events.error
						: result?.status === "warning"
							? events.warning
							: undefined;
				if (!id || !result) continue;
				emitEvent({
					id,
					teamId: app.teamId,
					subject: domain.host,
					serverId: server.id,
					appId: app.id,
					params: {
						detail: renderCheckDetail(notificationI18n(), result.message),
					},
				});
			}
		} catch (error) {
			console.warn(`[notifications] cert scan of ${domain.host} failed`, error);
		}
	}
}

/** Enabled app schedules without a successful backup in BACKUP_STALE_DAYS. */
async function runBackupStaleCheck(now = new Date()): Promise<void> {
	const days = getConfig().BACKUP_STALE_DAYS;
	const cutoff = new Date(now.getTime() - days * 86_400_000);
	const policies = await db
		.select({ policy: backupPolicies, app: apps })
		.from(backupPolicies)
		.innerJoin(apps, eq(apps.id, backupPolicies.appId))
		.where(
			and(
				eq(backupPolicies.enabled, true),
				isNotNull(backupPolicies.appId),
				// A schedule younger than the window can't be late yet.
				lt(backupPolicies.createdAt, cutoff),
			),
		);
	for (const { policy, app } of policies) {
		const [recent] = await db
			.select({ id: backups.id })
			.from(backups)
			.where(
				and(
					eq(backups.appId, app.id),
					eq(backups.status, "success"),
					gt(backups.createdAt, cutoff),
				),
			)
			.orderBy(desc(backups.createdAt))
			.limit(1);
		if (recent) continue;
		emitEvent({
			id: "backup.stale",
			teamId: policy.teamId,
			subject: app.id,
			serverId: app.serverId,
			appId: app.id,
			params: { days: String(days) },
		});
	}
}

async function pruneAudit(now = new Date()): Promise<void> {
	const cutoff = new Date(
		now.getTime() - getConfig().AUDIT_RETENTION_DAYS * 86_400_000,
	);
	await db.delete(auditEvents).where(lt(auditEvents.at, cutoff));
}

/** Boot: cert scan, stale-backup check and platform retention jobs. */
export function registerPlatformSchedules(): void {
	const config = getConfig();
	schedule("notify:cert-scan", config.CERT_SCAN_CRON, () => runCertScan());
	schedule("notify:backup-stale", config.BACKUP_STALE_CRON, () =>
		runBackupStaleCheck(),
	);
	schedule("platform:rate-limits", config.RATE_LIMIT_PRUNE_CRON, async () => {
		await pruneRateLimits(
			Math.max(config.LOGIN_RATE_WINDOW_MS, config.TWO_FACTOR_RATE_WINDOW_MS),
		);
	});
	schedule("platform:retention", config.PLATFORM_RETENTION_CRON, async () => {
		await pruneAudit();
		await pruneDeliveries();
		await pruneSessions();
		await pruneOldJobs();
	});
}
