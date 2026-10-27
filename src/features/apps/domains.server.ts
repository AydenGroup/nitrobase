import { and, eq } from "drizzle-orm";
import { getConfig } from "#/config/server.ts";
import { isUniqueViolation } from "#/db/errors.ts";
import { db } from "#/db/index.ts";
import { apps, domains } from "#/db/schema/apps.ts";
import { type Actor, systemActor } from "#/features/auth/access.ts";
import {
	onServerIdle,
	withAppServerLock,
} from "#/features/deployments/deployments.server.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import { serverTunnelStatus } from "#/features/servers/tunnel.server.ts";
import {
	type ExtraDomainRule,
	extraDomainRule,
	extraDomainRules,
} from "#/features/templates/schema.ts";
import { asTemplateText, type ErrorInfo } from "#/libs/coded.ts";
import { audit } from "#/server/services/audit.ts";
import {
	type DomainCheckResult,
	dnsChecker,
	domainCheckers,
} from "#/server/services/domains/checkers.ts";
import { normalizeDomainInput } from "#/server/services/domains/normalize.ts";
import { pendingRoutesListener } from "#/server/services/jobs/idle-hooks.ts";
import type { TunnelState } from "#/server/services/tunnel.ts";
import { AppError, coded } from "#/utils/error.ts";
import { startRoutesJob } from "./app-jobs.server";
import {
	assertHostAvailable,
	deployedServices,
	getAppManifest,
	getAppRow,
	getAppServer,
	listAppDomains,
	resolveServerIps,
} from "./apps.server";
import type { AddDomainInput, AppRow, DomainRow } from "./schema";

function normalizeDomain(value: string): string {
	try {
		return normalizeDomainInput(value);
	} catch {
		throw new AppError("DOMAIN_INVALID", { host: value });
	}
}

export async function addDomain(
	actor: Actor,
	input: AddDomainInput,
): Promise<{
	domain: DomainRow;
	deploymentId: string | null;
	/** DNS check right after adding (a warning, never a refusal). */
	dns: DomainCheckResult | null;
	/**
	 * The template limits additional domains on this service and port
	 * (`extra_domains` policy `warn`): why, shown after adding.
	 */
	limitation: ErrorInfo | null;
}> {
	const app = await getAppRow(actor, input.appId);
	const host = normalizeDomain(input.host);
	await assertHostAvailable(host);
	const { domain, rule } = await withAppServerLock(app, () =>
		insertDomain(actor, app, host, input),
	);
	const deploymentId = await applyRoutes(actor, app);
	let dns: DomainCheckResult | null = null;
	if (!domain.viaTunnel) {
		const server = await getAppServer(app);
		const serverIps = await resolveServerIps(server).catch(
			() => [] as string[],
		);
		const config = getConfig();
		dns = await dnsChecker.run({
			host,
			https: domain.https,
			serverIps,
			timeoutMs: config.DOMAIN_CHECK_TIMEOUT_MS,
			expiryWarningDays: config.CERT_EXPIRY_WARNING_DAYS,
		});
		await db
			.update(domains)
			.set({
				checks: {
					...domain.checks,
					[dnsChecker.id]: { ...dns, checkedAt: new Date().toISOString() },
				},
				lastCheckedAt: new Date(),
			})
			.where(eq(domains.id, domain.id));
	}
	// Every check (certificate too) once the route is live.
	scheduleDomainChecks(app.id);
	return {
		domain,
		deploymentId,
		dns,
		limitation: rule
			? coded("DOMAIN_EXTRA_LIMITED", extraDomainParams(rule))
			: null,
	};
}

/**
 * Check an app's domains again shortly (after a deploy or a routes job:
 * Traefik reload and certificate issuance take a moment). Background,
 * best effort.
 */
export function scheduleDomainChecks(appId: string): void {
	setTimeout(() => {
		void (async () => {
			const [app] = await db
				.select()
				.from(apps)
				.where(eq(apps.id, appId))
				.limit(1);
			if (!app) return;
			const server = await getAppServer(app);
			const serverIps = await resolveServerIps(server).catch(
				() => [] as string[],
			);
			const rows = await listAppDomains(app.id);
			const tunnel = await tunnelCheckInput(server, rows);
			await Promise.all(
				rows.map((row) => runDomainChecks(row, serverIps, tunnel)),
			);
		})().catch(() => {});
	}, getConfig().DOMAIN_RECHECK_DELAY_MS).unref?.();
}

/**
 * Start the routes job after the lock is released. If another job grabbed
 * the server in between, flag the app: the idle hook applies it as soon as
 * that job finishes (see registerPendingRoutes).
 */
async function applyRoutes(actor: Actor, app: AppRow): Promise<string | null> {
	try {
		return (await startRoutesJob(actor, app)).deploymentId;
	} catch (error) {
		if (error instanceof AppError && error.code === "SERVER_BUSY") {
			// Another job holds the server: flag it; applied when the server is idle.
			registerPendingRoutes();
			await db
				.update(apps)
				.set({ routesPending: true, updatedAt: new Date() })
				.where(eq(apps.id, app.id));
			return null;
		}
		throw error;
	}
}

function extraDomainParams(rule: ExtraDomainRule) {
	return {
		service: rule.service,
		port: String(rule.port),
		reason: asTemplateText(rule.reason),
	};
}

/**
 * The template's rule for an additional domain on the requested service
 * and port (`[[domains]] extra_domains`): `refuse` throws, `warn` is
 * returned so the caller can say why the domain is limited.
 */
async function extraDomainCheck(
	app: AppRow,
	input: Pick<AddDomainInput, "service" | "port">,
	primary: boolean,
): Promise<ExtraDomainRule | null> {
	const manifest = await getAppManifest(app).catch(() => null);
	const rule = extraDomainRule(extraDomainRules(manifest?.domains ?? []), {
		service: input.service,
		port: input.port,
		primary,
	});
	if (rule?.policy === "refuse") {
		throw new AppError("DOMAIN_EXTRA_REFUSED", extraDomainParams(rule));
	}
	return rule;
}

async function insertDomain(
	actor: Actor,
	app: AppRow,
	host: string,
	input: AddDomainInput,
): Promise<{ domain: DomainRow; rule: ExtraDomainRule | null }> {
	const services = deployedServices(app);
	const existing = await listAppDomains(app.id);
	const known = new Set([
		...services,
		...existing.map((domain) => domain.service),
	]);
	if (!known.has(input.service)) {
		throw new AppError("APP_SERVICE_NOT_FOUND", { service: input.service });
	}
	// The first domain becomes the primary one: never limited.
	const rule = await extraDomainCheck(app, input, existing.length === 0);
	const server = await getAppServer(app);
	if (input.viaTunnel && !server.tunnelEnabled) {
		throw new AppError("TUNNEL_NOT_CONFIGURED");
	}
	const [taken] = await db
		.select({ id: domains.id, appId: domains.appId })
		.from(domains)
		.where(eq(domains.host, host))
		.limit(1);
	if (taken) {
		throw new AppError(
			taken.appId === app.id ? "DOMAIN_ALREADY_ADDED" : "DOMAIN_TAKEN",
			{ host },
		);
	}

	let domain: DomainRow;
	try {
		[domain] = await db
			.insert(domains)
			.values({
				appId: app.id,
				host,
				service: input.service,
				port: input.port,
				https: input.https,
				// A tunnel-only server serves every domain through the tunnel.
				viaTunnel: server.tunnelOnly || input.viaTunnel,
				primary: existing.length === 0,
			})
			.returning();
	} catch (error) {
		// Unique index on host: a concurrent request may have won the race.
		if (isUniqueViolation(error)) throw new AppError("DOMAIN_TAKEN", { host });
		throw error;
	}
	audit({
		actor,
		action: "app.domain.add",
		targetType: "app",
		targetId: app.id,
		meta: { host, viaTunnel: domain.viaTunnel },
	});
	return { domain, rule };
}

export async function removeDomain(
	actor: Actor,
	appId: string,
	domainId: string,
): Promise<{ deploymentId: string | null }> {
	const app = await getAppRow(actor, appId);
	await withAppServerLock(app, async () => {
		const [domain] = await db
			.select()
			.from(domains)
			.where(and(eq(domains.id, domainId), eq(domains.appId, app.id)))
			.limit(1);
		if (!domain) throw new AppError("DOMAIN_NOT_FOUND");
		if (domain.primary) throw new AppError("DOMAIN_PRIMARY_REQUIRED");
		await db.delete(domains).where(eq(domains.id, domain.id));
		audit({
			actor,
			action: "app.domain.remove",
			targetType: "app",
			targetId: app.id,
			meta: { host: domain.host },
		});
	});
	return { deploymentId: await applyRoutes(actor, app) };
}

/**
 * Make a domain primary. The primary host feeds template variables (URLs),
 * so the app needs a redeploy for env values to follow.
 */
export async function setPrimaryDomain(
	actor: Actor,
	appId: string,
	domainId: string,
): Promise<void> {
	const app = await getAppRow(actor, appId);
	await withAppServerLock(app, () =>
		db.transaction(async (tx) => {
			const [domain] = await tx
				.select()
				.from(domains)
				.where(and(eq(domains.id, domainId), eq(domains.appId, app.id)))
				.limit(1);
			if (!domain) throw new AppError("DOMAIN_NOT_FOUND");
			await tx
				.update(domains)
				.set({ primary: false })
				.where(eq(domains.appId, app.id));
			await tx
				.update(domains)
				.set({ primary: true })
				.where(eq(domains.id, domain.id));
			await tx
				.update(apps)
				.set({ needsRedeploy: true, updatedAt: new Date() })
				.where(eq(apps.id, app.id));
		}),
	);
	audit({
		actor,
		action: "app.domain.primary",
		targetType: "app",
		targetId: app.id,
	});
}

/** Run every registered checker for the app's domains and store results. */
/** Run every registered checker on one domain and store the results. */
export async function runDomainChecks(
	row: DomainRow,
	serverIps: string[],
	/** The server's tunnel: mode and connector state (when it has one). */
	tunnel: { only: boolean; enabled?: boolean; state?: TunnelState } = {
		only: false,
	},
): Promise<DomainRow["checks"]> {
	const config = getConfig();
	const input = {
		host: row.host,
		https: row.https,
		// "Via tunnel" counts while the server's tunnel is on.
		viaTunnel: tunnel.only || (!!tunnel.enabled && row.viaTunnel),
		tunnelState: tunnel.state,
		serverIps,
		timeoutMs: config.DOMAIN_CHECK_TIMEOUT_MS,
		expiryWarningDays: config.CERT_EXPIRY_WARNING_DAYS,
	};
	const checkedAt = new Date();
	const checks = { ...row.checks };
	for (const checker of domainCheckers) {
		if (checker.appliesTo && !checker.appliesTo(input)) {
			delete checks[checker.id];
			continue;
		}
		const result = await checker.run(input);
		checks[checker.id] = { ...result, checkedAt: checkedAt.toISOString() };
	}
	await db
		.update(domains)
		.set({ checks, lastCheckedAt: checkedAt })
		.where(eq(domains.id, row.id));
	return checks;
}

/** Tunnel mode + connector state, read only when a domain needs it. */
export async function tunnelCheckInput(
	server: ServerRow,
	rows: Pick<DomainRow, "viaTunnel">[],
): Promise<{ only: boolean; enabled: boolean; state?: TunnelState }> {
	const needed =
		server.tunnelOnly ||
		(server.tunnelEnabled && rows.some((row) => row.viaTunnel));
	if (!needed) return { only: false, enabled: server.tunnelEnabled };
	const status = await serverTunnelStatus(server).catch(() => null);
	return {
		only: server.tunnelOnly,
		enabled: server.tunnelEnabled,
		state: status?.state,
	};
}

export async function checkDomains(
	actor: Actor,
	appId: string,
): Promise<DomainRow[]> {
	const app = await getAppRow(actor, appId);
	const server = await getAppServer(app);
	const serverIps = await resolveServerIps(server).catch(() => [] as string[]);
	const rows = await listAppDomains(app.id);
	const tunnel = await tunnelCheckInput(server, rows);
	await Promise.all(rows.map((row) => runDomainChecks(row, serverIps, tunnel)));
	return listAppDomains(app.id);
}

// Registration flag and attempt map live on globalThis (like the job state),
// so a dev HMR reload doesn't add a second listener.
const pendingRoutesState = globalThis as typeof globalThis & {
	__nitrobasePendingRoutes?: {
		registered: boolean;
		attempts: Map<string, number>;
	};
};

/**
 * Forget the automatic-retry backoff of these apps: a server-wide change
 * (tunnel mode) flags their routes and they must be applied right away.
 */
export function resetPendingRoutesBackoff(appIds: string[]): void {
	const state = pendingRoutesState.__nitrobasePendingRoutes;
	for (const id of appIds) state?.attempts.delete(id);
}

/** Apply pending routes whenever a server's job lock is released. */
export function registerPendingRoutes(): void {
	pendingRoutesState.__nitrobasePendingRoutes ??= {
		registered: false,
		attempts: new Map(),
	};
	const state = pendingRoutesState.__nitrobasePendingRoutes;
	if (state.registered) return;
	state.registered = true;
	onServerIdle(
		pendingRoutesListener({
			attempts: state.attempts,
			backoffMs: getConfig().ROUTES_RETRY_BACKOFF_MS,
			listPending: (serverId) =>
				db
					.select({ appId: apps.id, teamId: apps.teamId })
					.from(apps)
					.where(and(eq(apps.serverId, serverId), eq(apps.routesPending, true)))
					.orderBy(apps.updatedAt)
					.limit(20),
			startRoutes: async (appId, teamId) => {
				const actor = systemActor(teamId);
				const app = await getAppRow(actor, appId);
				return startRoutesJob(actor, app);
			},
		}),
	);
}

export interface DomainListItem extends DomainRow {
	appName: string;
	serverId: string;
}

/** Every domain of the user's apps (Infrastructure → Domains). */
export async function listAllDomains(actor: Actor): Promise<DomainListItem[]> {
	const rows = await db
		.select({ domain: domains, appName: apps.name, serverId: apps.serverId })
		.from(domains)
		.innerJoin(apps, eq(apps.id, domains.appId))
		.where(eq(apps.teamId, actor.teamId))
		.orderBy(domains.host);
	return rows.map((row) => ({
		...row.domain,
		appName: row.appName,
		serverId: row.serverId,
	}));
}
