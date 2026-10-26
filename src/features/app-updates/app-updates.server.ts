import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { appSources } from "#/config/app-sources.ts";
import { getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { appUpdates } from "#/db/schema/updates.ts";
import { getAppManifest, getAppRow } from "#/features/apps/apps.server.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import { sourceKindOf } from "#/features/apps/sources.server.ts";
import { type Actor, systemActor } from "#/features/auth/access.ts";
import type { TemplateManifest } from "#/features/templates/schema.ts";
import { errorInfo } from "#/libs/coded.ts";
import { nextRunAt, schedulerClock } from "#/libs/cron.ts";
import { clip } from "#/libs/format.ts";
import type { UpdateCandidate } from "#/server/services/app-updates/candidates.ts";
import {
	type AppUpdatePolicy,
	autoUpdateAllowed,
} from "#/server/services/app-updates/policy.ts";
import { audit } from "#/server/services/audit.ts";
import { errorColumns } from "#/server/services/error-info.ts";
import { emitEvent } from "#/server/services/events/bus.ts";
import { schedule } from "#/server/services/scheduler.ts";
import { AppError } from "#/utils/error.ts";
import type { AppUpdateView, AutoUpdateWindow } from "./schema";
import { type UpdateSourceDriver, updateDrivers } from "./sources.server";

/**
 * App update checks and policies (R4 M4). A scheduled check asks every
 * deployed app's source for something newer (template releases/tags/
 * branches, database engine tags, the branch tip of a Git app), stores it
 * in `app_updates` and sends `app.update_available` once per version.
 * Apps with an auto policy are updated in the maintenance window
 * (#/features/app-updates/update-jobs.server.ts).
 */

export type UpdateRow = typeof appUpdates.$inferSelect;

/** Apps whose deployed version can be compared (not pending/deleting). */
const CHECKABLE = ["running", "stopped", "error"] as const;

export async function driverFor(app: AppRow): Promise<{
	manifest: TemplateManifest;
	driver: UpdateSourceDriver | null;
}> {
	const manifest = await getAppManifest(app);
	const kind = sourceKindOf(manifest);
	return {
		manifest,
		driver: appSources[kind].updatable ? updateDrivers[kind] : null,
	};
}

export async function getUpdateRow(appId: string): Promise<UpdateRow | null> {
	const [row] = await db
		.select()
		.from(appUpdates)
		.where(eq(appUpdates.appId, appId))
		.limit(1);
	return row ?? null;
}

async function upsertRow(
	appId: string,
	patch: Partial<typeof appUpdates.$inferInsert>,
): Promise<UpdateRow> {
	const [row] = await db
		.insert(appUpdates)
		.values({ appId, ...patch, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: appUpdates.appId,
			set: { ...patch, updatedAt: new Date() },
		})
		.returning();
	return row;
}

/** Record the outcome of an update (and clear the offer once applied). */
export async function recordUpdateResult(
	appId: string,
	result: Pick<UpdateRow, "lastResult" | "lastDeploymentId">,
	applied: string | null,
): Promise<void> {
	const row = await getUpdateRow(appId);
	await upsertRow(appId, {
		...result,
		lastResultAt: new Date(),
		...(applied && row?.latestVersion === applied
			? {
					latestVersion: null,
					latestName: null,
					latestUrl: null,
					latestPublishedAt: null,
					latestKind: null,
				}
			: {}),
	});
}

function candidatePatch(candidate: UpdateCandidate | null) {
	return {
		latestVersion: candidate?.version ?? null,
		latestName: candidate?.name ?? null,
		latestUrl: candidate?.url ?? null,
		latestPublishedAt: candidate?.publishedAt
			? new Date(candidate.publishedAt)
			: null,
		latestKind: candidate?.kind ?? null,
	};
}

/** Check one app; returns its new row. Errors are stored, not thrown. */
async function checkApp(
	app: AppRow,
	options: { refresh?: boolean; skipGit?: boolean } = {},
): Promise<UpdateRow | null> {
	if (!(CHECKABLE as readonly string[]).includes(app.status)) return null;
	let resolved: Awaited<ReturnType<typeof driverFor>>;
	try {
		resolved = await driverFor(app);
	} catch {
		return null;
	}
	const { manifest, driver } = resolved;
	if (!driver) return null;
	if (options.skipGit && sourceKindOf(manifest) === "git") return null;
	const previous = await getUpdateRow(app.id);
	let candidate: UpdateCandidate | null;
	try {
		candidate = await driver.latest(app, manifest, {
			refresh: !!options.refresh,
		});
	} catch (error) {
		return upsertRow(app.id, {
			checkedAt: new Date(),
			...checkErrorColumns(error),
		});
	}
	const row = await upsertRow(app.id, {
		...candidatePatch(candidate),
		checkedAt: new Date(),
		...checkErrorColumns(null),
	});
	if (candidate && previous?.notifiedVersion !== candidate.version) {
		emitEvent({
			id: "app.update_available",
			teamId: app.teamId,
			subject: `${app.id}:${candidate.version}`,
			serverId: app.serverId,
			appId: app.id,
			params: {
				target: app.name,
				from: driver.current(app),
				to: candidate.name,
				kind: candidate.kind,
			},
		});
		return upsertRow(app.id, { notifiedVersion: candidate.version });
	}
	return row;
}

/** Bounded-concurrency map (checks call GitHub or a server each). */
async function eachLimited<T>(
	items: T[],
	limit: number,
	run: (item: T) => Promise<unknown>,
): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const item = items[next++];
			await run(item).catch((error) =>
				console.error("[app-updates] check failed", error),
			);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
}

/** Check every checkable app (one team, or all for the schedule). */
async function checkAllApps(
	options: { teamId?: string; refresh?: boolean } = {},
): Promise<number> {
	const rows = await db
		.select()
		.from(apps)
		.where(
			and(
				inArray(apps.status, [...CHECKABLE]),
				options.teamId ? eq(apps.teamId, options.teamId) : undefined,
			),
		);
	const config = getConfig();
	await eachLimited(rows, config.APP_UPDATE_CHECK_CONCURRENCY, (app) =>
		checkApp(app, {
			refresh: options.refresh,
			skipGit: !config.APP_UPDATE_CHECK_GIT,
		}),
	);
	return rows.length;
}

/** "Check for updates" on one app (asks the source again). */
export async function checkAppNow(
	actor: Actor,
	appId: string,
): Promise<AppUpdateView> {
	const app = await getAppRow(actor, appId, "app.deploy");
	await checkApp(app, { refresh: true });
	return getAppUpdateView(actor, appId);
}

function toView(
	app: AppRow,
	row: UpdateRow | null,
	resolved: Awaited<ReturnType<typeof driverFor>> | null,
): AppUpdateView {
	const driver = resolved?.driver ?? null;
	let rollback: AppUpdateView["rollback"] = "manual";
	try {
		if (driver && resolved) rollback = driver.rollback(app, resolved.manifest);
	} catch {
		rollback = "manual";
	}
	return {
		appId: app.id,
		policy: row?.policy ?? "notify",
		supported: !!driver,
		available: !!driver && !!row?.latestVersion,
		current: driver ? driver.current(app) : app.version,
		version: row?.latestVersion ?? null,
		name: row?.latestName ?? null,
		url: row?.latestUrl ?? null,
		kind: row?.latestKind ?? null,
		rollback,
		checkedAt: row?.checkedAt?.toISOString() ?? null,
		checkError: errorInfo(
			row?.checkError,
			row?.checkErrorCode,
			row?.checkErrorParams,
		),
		lastResult: row?.lastResult ?? null,
		lastResultAt: row?.lastResultAt?.toISOString() ?? null,
		lastDeploymentId: row?.lastDeploymentId ?? null,
	};
}

/** `check_error*` columns of an update check failure (null clears them). */
function checkErrorColumns(error: unknown) {
	const columns = errorColumns(error);
	return {
		checkError: columns.error
			? clip(columns.error, TEXT_LIMITS.storedError)
			: null,
		checkErrorCode: columns.errorCode,
		checkErrorParams: columns.errorParams,
	};
}

async function getAppUpdateView(
	actor: Actor,
	appId: string,
): Promise<AppUpdateView> {
	const app = await getAppRow(actor, appId);
	return toView(
		app,
		await getUpdateRow(app.id),
		await driverFor(app).catch(() => null),
	);
}

/** Update state of every app of the actor's team (badges, lists). */
export async function listAppUpdates(actor: Actor): Promise<AppUpdateView[]> {
	const rows = await db
		.select({ app: apps, update: appUpdates })
		.from(apps)
		.leftJoin(appUpdates, eq(appUpdates.appId, apps.id))
		.where(eq(apps.teamId, actor.teamId));
	return Promise.all(
		rows.map(async ({ app, update }) =>
			toView(app, update, await driverFor(app).catch(() => null)),
		),
	);
}

export async function setUpdatePolicy(
	actor: Actor,
	input: { appId: string; policy: AppUpdatePolicy },
): Promise<AppUpdateView> {
	const app = await getAppRow(actor, input.appId, "app.update_policy.manage");
	const { driver } = await driverFor(app);
	if (!driver && input.policy !== "notify") {
		throw new AppError("APP_UPDATE_UNSUPPORTED");
	}
	const before = await getUpdateRow(app.id);
	await upsertRow(app.id, { policy: input.policy });
	audit({
		actor,
		action: "app.update_policy",
		targetType: "app",
		targetId: app.id,
		meta: { from: before?.policy ?? "notify", to: input.policy },
	});
	return getAppUpdateView(actor, app.id);
}

export function autoUpdateWindow(now = new Date()): AutoUpdateWindow {
	const config = getConfig();
	const nextStart =
		nextRunAt(config.APP_AUTO_UPDATE_CRON, { after: now })?.toISOString() ??
		null;
	return {
		cron: config.APP_AUTO_UPDATE_CRON,
		minutes: config.APP_AUTO_UPDATE_WINDOW_MINUTES,
		nextStart,
		timeZone: schedulerClock(now).timeZone,
	};
}

/**
 * Apps due for an automatic update: policy allows the kind, the version
 * was not tried automatically before, the app runs.
 */
export async function dueAutoUpdates(): Promise<
	{ app: AppRow; update: UpdateRow }[]
> {
	const rows = await db
		.select({ app: apps, update: appUpdates })
		.from(appUpdates)
		.innerJoin(apps, eq(apps.id, appUpdates.appId))
		.where(
			and(
				ne(appUpdates.policy, "notify"),
				isNotNull(appUpdates.latestVersion),
				eq(apps.status, "running"),
			),
		);
	return rows.filter(
		({ update }) =>
			update.autoAttemptedVersion !== update.latestVersion &&
			autoUpdateAllowed(update.policy, update.latestKind),
	);
}

export async function markAutoAttempted(
	appId: string,
	version: string,
): Promise<void> {
	await upsertRow(appId, { autoAttemptedVersion: version });
}

/** Scheduled check + automatic updates in the maintenance window. */
export function registerAppUpdateSchedules(): void {
	const config = getConfig();
	if (config.APP_UPDATE_CHECK_ENABLED) {
		schedule("app-update-check", config.APP_UPDATE_CHECK_CRON, async () => {
			// Template lists come from the GitHub cache (TEMPLATE_CACHE_TTL_MS).
			await checkAllApps();
		});
	}
	schedule("app-auto-update", config.APP_AUTO_UPDATE_CRON, async () => {
		const { runAutoUpdates } = await import("./update-jobs.server");
		await runAutoUpdates(new Date());
	});
}

/** System actor of a team for automatic updates. */
export function autoUpdateActor(app: AppRow): Actor {
	return systemActor(app.teamId, app.userId);
}
