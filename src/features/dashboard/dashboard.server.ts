import { and, desc, eq, isNotNull } from "drizzle-orm";
import { destinationDrivers } from "#/config/backup-drivers.ts";
import { DATABASE_TEMPLATE_ID } from "#/config/database-engines.ts";
import type { OnboardingStepId } from "#/config/onboarding.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { backupDestinations, backupPolicies } from "#/db/schema/backups.ts";
import { notificationChannels } from "#/db/schema/platform.ts";
import { servers } from "#/db/schema/server.ts";
import { users } from "#/db/schema/user.ts";
import { listAllDomains } from "#/features/apps/domains.server.ts";
import type { DomainCheckStatus } from "#/features/apps/schema.ts";
import type { Actor } from "#/features/auth/access.ts";
import { listJobs } from "#/features/deployments/jobs.server.ts";
import { listAlerts } from "#/features/monitoring/monitoring.server.ts";
import { serverHealthSummaries } from "#/features/monitoring/service.server.ts";
import { getSetting } from "#/features/settings/settings.server.ts";
import { installGuideUrl } from "#/features/upgrade/release.server.ts";
import type { DashboardData } from "./schema";

function countBy<T extends string>(values: T[]): Partial<Record<T, number>> {
	const out: Partial<Record<T, number>> = {};
	for (const value of values) out[value] = (out[value] ?? 0) + 1;
	return out;
}

/** First-run checklist: completion of each step from real state. */
async function getOnboarding(
	actor: Actor,
	serverRows: { status: string }[],
	appRows: { status: string }[],
): Promise<Record<OnboardingStepId, boolean>> {
	const [destinationRows, policyRows, channelRows, account, panelDomain] =
		await Promise.all([
			db
				.select({ type: backupDestinations.type })
				.from(backupDestinations)
				.where(eq(backupDestinations.teamId, actor.teamId)),
			db
				.select({ id: backupPolicies.id })
				.from(backupPolicies)
				.where(
					and(
						eq(backupPolicies.teamId, actor.teamId),
						eq(backupPolicies.enabled, true),
						isNotNull(backupPolicies.appId),
					),
				)
				.limit(1),
			db
				.select({ id: notificationChannels.id })
				.from(notificationChannels)
				.where(
					and(
						eq(notificationChannels.teamId, actor.teamId),
						eq(notificationChannels.enabled, true),
					),
				)
				.limit(1),
			actor.userId
				? db
						.select({ totp: users.totpEnabledAt })
						.from(users)
						.where(eq(users.id, actor.userId))
						.limit(1)
				: Promise.resolve([]),
			getSetting("instance.panelDomain"),
		]);
	const offSite = new Set(
		destinationDrivers
			.filter((driver) => !driver.capabilities.onServer)
			.map((driver) => driver.type),
	);
	const done = {
		server: serverRows.some((server) => server.status === "ready"),
		app: appRows.some((app) => app.status === "running"),
		offsite: destinationRows.some((row) => offSite.has(row.type)),
		schedule: policyRows.length > 0,
		notifications: channelRows.length > 0,
		twoFactor: !!account[0]?.totp,
		panelDomain: !!panelDomain,
	} satisfies Record<OnboardingStepId, boolean>;
	return done;
}

/** Severity order of domain checks: the worst one stands for the domain. */
const CHECK_SEVERITY: DomainCheckStatus[] = ["error", "warning", "ok"];

function worstCheckStatus(
	checks: Record<string, { status: DomainCheckStatus }>,
): DomainCheckStatus {
	const statuses = new Set(Object.values(checks).map((check) => check.status));
	return CHECK_SEVERITY.find((status) => statuses.has(status)) ?? "unknown";
}

export async function getDashboard(actor: Actor): Promise<DashboardData> {
	const [serverRows, appRows, domainRows, jobs, openAlerts] = await Promise.all(
		[
			db
				.select({
					id: servers.id,
					name: servers.name,
					host: servers.host,
					isDefault: servers.isDefault,
					status: servers.status,
					dockerVersion: servers.dockerVersion,
					lastError: servers.lastError,
				})
				.from(servers)
				.where(eq(servers.teamId, actor.teamId))
				.orderBy(desc(servers.createdAt)),
			db
				.select({
					id: apps.id,
					name: apps.name,
					status: apps.status,
					templateId: apps.templateId,
				})
				.from(apps)
				.where(eq(apps.teamId, actor.teamId)),
			listAllDomains(actor),
			listJobs(actor, { limit: 50 }),
			listAlerts(actor, { status: "open", limit: 50 }),
		],
	);
	const [serverHealth, onboarding] = await Promise.all([
		serverHealthSummaries(serverRows.map((server) => server.id)),
		getOnboarding(actor, serverRows, appRows),
	]);
	const visibleJobs = jobs.filter(
		(job) => job.type !== "terminal" && job.type !== "app_terminal",
	);
	const dayAgo = Date.now() - 24 * 60 * 60_000;
	return {
		installGuideUrl: installGuideUrl(),
		onboarding,
		servers: serverRows,
		serverHealth,
		openAlerts,
		diskAlertPercent: getConfig().ALERT_DISK_PERCENT,
		serversByStatus: countBy(serverRows.map((server) => server.status)),
		// Databases are apps, counted on their own.
		appsByStatus: countBy(
			appRows
				.filter((app) => app.templateId !== DATABASE_TEMPLATE_ID)
				.map((app) => app.status),
		),
		appCount: appRows.filter((app) => app.templateId !== DATABASE_TEMPLATE_ID)
			.length,
		databasesByStatus: countBy(
			appRows
				.filter((app) => app.templateId === DATABASE_TEMPLATE_ID)
				.map((app) => app.status),
		),
		databaseCount: appRows.filter(
			(app) => app.templateId === DATABASE_TEMPLATE_ID,
		).length,
		domainCount: domainRows.length,
		domainsByCheck: countBy(
			domainRows.map((domain) => worstCheckStatus(domain.checks)),
		),
		jobsRunning: visibleJobs.filter((job) => job.status === "running").length,
		jobsFailed24h: visibleJobs.filter(
			(job) => job.status === "failed" && job.createdAt.getTime() > dayAgo,
		).length,
		jobsSucceeded24h: visibleJobs.filter(
			(job) => job.status === "success" && job.createdAt.getTime() > dayAgo,
		).length,
		recentJobs: visibleJobs.slice(0, 8),
		domainIssues: domainRows
			.filter((domain) =>
				Object.values(domain.checks).some(
					(check) => check.status === "error" || check.status === "warning",
				),
			)
			.map((domain) => ({
				id: domain.id,
				host: domain.host,
				appId: domain.appId,
				appName: domain.appName,
				checks: domain.checks,
			}))
			.slice(0, 10),
	};
}
