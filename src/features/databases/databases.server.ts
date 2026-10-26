import { randomBytes, randomInt } from "node:crypto";
import { and, desc, eq, inArray, type or } from "drizzle-orm";
import {
	canUpgradeInPlace,
	DATABASE_TEMPLATE_ID,
	type DatabaseEngineId,
	databaseEngines,
	engineVersion,
	parseDatabaseVersion,
	upgradeTargets,
} from "#/config/database-engines.ts";
import { jobTitle } from "#/config/job-titles.ts";
import type { Permission } from "#/config/permissions.ts";
import { getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { isUniqueViolation } from "#/db/errors.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { databaseLinks } from "#/db/schema/databases.ts";
import { servers } from "#/db/schema/server.ts";
import {
	appInputs,
	containerName,
	deployedServices,
	getAppRow,
	getAppServer,
	readEnvValues,
	resolveServerIps,
} from "#/features/apps/apps.server.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import { type Actor, assertCanAccess } from "#/features/auth/access.ts";
import { startJob } from "#/features/deployments/deployments.server.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import { clip, clipEnd } from "#/libs/format.ts";
import { audit } from "#/server/services/audit.ts";
import {
	assertManagedDatabase,
	assertManagedUser,
} from "#/server/services/databases/admin.ts";
import {
	clientCommand,
	connectionUrl,
	sshTunnelCommand,
} from "#/server/services/databases/connection.ts";
import type { ConsoleLimits } from "#/server/services/databases/console.ts";
import type {
	AdminStep,
	EngineAdmin,
	EngineTarget,
} from "#/server/services/databases/engines/common.ts";
import {
	DATABASE_PORT_ID,
	DATABASE_SERVICE,
	type DatabaseLogin,
	serverEngine,
} from "#/server/services/databases/engines.ts";
import { type CappedRun, runCapped } from "#/server/services/databases/exec.ts";
import {
	assertLinkEnvName,
	connectNetworkCommand,
	disconnectNetworkCommand,
	type LinkEnvEntry,
	linkNetworkName,
	removeLinkNetworkCommand,
} from "#/server/services/databases/links.ts";
import type { Executor } from "#/server/services/executor.ts";
import { encrypt } from "#/utils/crypto.ts";
import { AppError } from "#/utils/error.ts";
import {
	ensureLinkNetworks,
	internalEndpoint,
	type LinkRow,
} from "./links.server";
import type {
	ConsoleResult,
	ConsoleRunInput,
	CreateDatabaseInput,
	DatabaseLinkView,
	DatabaseListItem,
	DatabaseOverview,
	LinkDatabaseInput,
	UsersView,
} from "./schema";

/**
 * Standalone databases (R3 M2). A database is an app of the `database`
 * template: lifecycle, backups, monitoring, limits, ownership, moves and
 * teams are the app's. This module adds what is specific: the list and
 * overview, connection details, links to apps, the console and users and
 * databases management. Every function checks its permission on the row
 * (`assertCanAccess`); server functions gate it first.
 */

/**
 * App jobs and backup steps, imported lazily: they import the app modules
 * this one builds on (a static cycle splits the server bundle badly).
 */
const appJobs = () => import("#/features/apps/app-jobs.server.ts");
const backupJobs = () => import("#/features/backups/jobs.server.ts");

interface DatabaseContext {
	app: AppRow;
	engine: DatabaseEngineId;
	tag: string;
}

/** A database of the actor's team (an app of the database template). */
async function databaseContext(
	actor: Actor,
	id: string,
	permission: Permission = "database.view",
): Promise<DatabaseContext> {
	const [row] = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
	const app = row && row.templateId === DATABASE_TEMPLATE_ID ? row : undefined;
	assertCanAccess(actor, app, permission, "DATABASE_NOT_FOUND");
	const parsed = parseDatabaseVersion((app as AppRow).version);
	if (!parsed) throw new AppError("DATABASE_NOT_FOUND");
	return { app: app as AppRow, engine: parsed.engine, tag: parsed.tag };
}

function valuesOf(app: AppRow): Record<string, string> {
	return { ...readEnvValues(app), ...appInputs(app).overrides };
}

function mainLogin(ctx: DatabaseContext): DatabaseLogin {
	return serverEngine(ctx.engine).login(valuesOf(ctx.app));
}

/** Deployed and running (console, users, size, links need the container). */
function assertRunning(app: AppRow): void {
	if (
		!deployedServices(app).includes(DATABASE_SERVICE) ||
		!["running", "deploying"].includes(app.status)
	) {
		throw new AppError("DATABASE_NOT_RUNNING");
	}
}

async function withExecutor<T>(
	app: AppRow,
	fn: (executor: Executor) => Promise<T>,
): Promise<T> {
	const executor = await getExecutor(await getAppServer(app));
	try {
		return await fn(executor);
	} finally {
		executor.close();
	}
}

const container = (app: AppRow) => containerName(app.folder, DATABASE_SERVICE);

const ALPHANUMERIC =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Random alphanumeric password (URL- and shell-safe). */
function generatePassword(length: number): string {
	let out = "";
	for (let i = 0; i < length; i++)
		out += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)];
	return out;
}

// ---------------------------------------------------------------------------
// List / overview

export async function listDatabases(actor: Actor): Promise<DatabaseListItem[]> {
	const rows = await db
		.select({
			app: apps,
			serverName: servers.name,
		})
		.from(apps)
		.innerJoin(servers, eq(servers.id, apps.serverId))
		.where(
			and(
				eq(apps.teamId, actor.teamId),
				eq(apps.templateId, DATABASE_TEMPLATE_ID),
			),
		)
		.orderBy(desc(apps.createdAt));
	const ids = rows.map((row) => row.app.id);
	const links = ids.length
		? await db
				.select({ databaseAppId: databaseLinks.databaseAppId })
				.from(databaseLinks)
				.where(inArray(databaseLinks.databaseAppId, ids))
		: [];
	return rows.flatMap(({ app, serverName }) => {
		const parsed = parseDatabaseVersion(app.version);
		if (!parsed) return [];
		return [
			{
				id: app.id,
				name: app.name,
				engine: parsed.engine,
				tag: parsed.tag,
				status: app.status,
				needsRedeploy: app.needsRedeploy,
				serverId: app.serverId,
				serverName,
				links: links.filter((link) => link.databaseAppId === app.id).length,
				exposed: DATABASE_PORT_ID in (appInputs(app).publishedPorts ?? {}),
				createdAt: app.createdAt,
			},
		];
	});
}

async function linkViews(
	where: ReturnType<typeof eq> | ReturnType<typeof or>,
): Promise<DatabaseLinkView[]> {
	const rows = await db
		.select()
		.from(databaseLinks)
		.where(where)
		.orderBy(desc(databaseLinks.createdAt));
	if (rows.length === 0) return [];
	const ids = [
		...new Set(rows.flatMap((row) => [row.appId, row.databaseAppId])),
	];
	const related = await db
		.select({
			id: apps.id,
			name: apps.name,
			status: apps.status,
			version: apps.version,
			needsRedeploy: apps.needsRedeploy,
		})
		.from(apps)
		.where(inArray(apps.id, ids));
	const byId = new Map(related.map((row) => [row.id, row]));
	return rows.flatMap((row) => {
		const app = byId.get(row.appId);
		const database = byId.get(row.databaseAppId);
		const parsed = database ? parseDatabaseVersion(database.version) : null;
		if (!app || !database || !parsed) return [];
		return [
			{
				id: row.id,
				databaseId: database.id,
				databaseName: database.name,
				databaseEngine: parsed.engine,
				appId: app.id,
				appName: app.name,
				appStatus: app.status,
				appNeedsRedeploy: app.needsRedeploy,
				env: row.env,
				database: row.database,
				username: row.username,
				createdAt: row.createdAt,
			},
		];
	});
}

/** Published endpoint of a database (null: not published). */
async function externalEndpoint(app: AppRow, server: ServerRow) {
	const inputs = appInputs(app);
	const hostPort = inputs.publishedPorts?.[DATABASE_PORT_ID];
	if (!hostPort) return null;
	const loopback = inputs.loopbackPorts?.includes(DATABASE_PORT_ID) ?? false;
	const host = loopback
		? "127.0.0.1"
		: ((await resolveServerIps(server).catch(() => []))[0] ?? server.host);
	return { host, port: hostPort, loopback };
}

export async function getDatabaseOverview(
	actor: Actor,
	id: string,
): Promise<DatabaseOverview> {
	const ctx = await databaseContext(actor, id);
	const { app, engine } = ctx;
	const server = await getAppServer(app);
	const login = mainLogin(ctx);
	const internal = internalEndpoint(app);
	const external = await externalEndpoint(app, server);
	const masked = { ...login, password: null };
	return {
		id: app.id,
		name: app.name,
		engine,
		tag: ctx.tag,
		status: app.status,
		consoleKind: databaseEngines[engine].console,
		manageUsers: databaseEngines[engine].manageUsers,
		server: { id: server.id, name: server.name, host: server.host },
		user: login.user,
		database: login.database,
		internal: {
			...internal,
			url: connectionUrl(engine, internal, masked),
			command: clientCommand(engine, internal, login),
		},
		external: external
			? {
					host: external.host,
					port: external.port,
					loopback: external.loopback,
					url: connectionUrl(engine, external, masked),
					command: clientCommand(engine, external, login),
					tunnel:
						external.loopback && server.port > 0
							? sshTunnelCommand({
									sshUser: server.username,
									sshHost: server.host,
									sshPort: server.port,
									hostPort: external.port,
									localPort: external.port,
								})
							: null,
				}
			: null,
		links: await linkViews(eq(databaseLinks.databaseAppId, app.id)),
		upgradeTargets: upgradeTargets(engine, ctx.tag).map((item) => item.tag),
		sizeBytes: sizeCache.get(app.id)?.bytes ?? null,
	};
}

/** Full connection string (password included): audited. */
export async function revealDatabaseConnection(
	actor: Actor,
	input: { databaseId: string; endpoint: "internal" | "external" },
): Promise<{ url: string; password: string }> {
	const ctx = await databaseContext(
		actor,
		input.databaseId,
		"database.credentials.reveal",
	);
	const login = mainLogin(ctx);
	const endpoint =
		input.endpoint === "internal"
			? internalEndpoint(ctx.app)
			: await externalEndpoint(ctx.app, await getAppServer(ctx.app));
	if (!endpoint) throw new AppError("DATABASE_UNSUPPORTED");
	audit({
		actor,
		action: "database.credentials.reveal",
		targetType: "app",
		targetId: ctx.app.id,
		meta: { endpoint: input.endpoint },
	});
	return {
		url: connectionUrl(ctx.engine, endpoint, login),
		password: login.password,
	};
}

// ---------------------------------------------------------------------------
// Create / upgrade

export async function createDatabase(
	actor: Actor,
	input: CreateDatabaseInput,
): Promise<{ appId: string; deploymentId: string }> {
	assertCanAccess(actor, "database.manage");
	if (!engineVersion(input.engine, input.version)) {
		throw new AppError("DATABASE_VERSION_INVALID", { version: input.version });
	}
	const inputs: Record<string, string> = {};
	if (input.user && databaseEngines[input.engine].defaultUser) {
		inputs.DB_USER = input.user;
	}
	if (input.database && databaseEngines[input.engine].defaultDatabase) {
		inputs.DB_NAME = input.database;
	}
	const { createAndDeployApp } = await appJobs();
	const created = await createAndDeployApp(
		actor,
		{
			templateId: DATABASE_TEMPLATE_ID,
			serverId: input.serverId,
			name: input.name,
			inputs,
			database: { engine: input.engine, version: input.version },
			acknowledged: true,
		},
		input.memoryMb
			? { resources: { [DATABASE_SERVICE]: { memoryMb: input.memoryMb } } }
			: undefined,
	);
	audit({
		actor,
		action: "database.create",
		targetType: "app",
		targetId: created.appId,
		meta: { engine: input.engine, version: input.version },
	});
	return created;
}

/** Move to a newer version of the same engine (backup first by default). */
export async function upgradeDatabase(
	actor: Actor,
	input: { databaseId: string; version: string; backupFirst: boolean },
): Promise<{ deploymentId: string }> {
	const ctx = await databaseContext(actor, input.databaseId, "database.manage");
	if (!canUpgradeInPlace(ctx.engine, ctx.tag, input.version)) {
		throw new AppError("DATABASE_UPGRADE_NOT_ALLOWED", {
			from: ctx.tag,
			to: input.version,
		});
	}
	const target = `${ctx.engine}@${input.version}`;
	const first = input.backupFirst
		? await (await backupJobs()).backupFirstStep(actor, ctx.app)
		: null;
	const { runDeploy, startAppJob } = await appJobs();
	audit({
		actor,
		action: "database.upgrade",
		targetType: "app",
		targetId: ctx.app.id,
		meta: { from: ctx.tag, to: input.version, backupFirst: input.backupFirst },
	});
	return startAppJob(
		ctx.app,
		actor,
		"app_update",
		jobTitle("app_update", { app: ctx.app.name, version: target }),
		async (job) => {
			await first?.(job);
			return runDeploy(ctx.app.id, "update", target, job);
		},
	);
}

// ---------------------------------------------------------------------------
// Size

const sizeCache = new Map<string, { bytes: number; at: number }>();

/** Limits of small internal runs (size, admin SQL, console login setup). */
function adminLimits(): ConsoleLimits {
	const config = getConfig();
	return {
		timeoutMs: config.DATABASE_ADMIN_TIMEOUT_MS,
		maxBytes: config.DATABASE_CONSOLE_MAX_OUTPUT_BYTES,
		maxErrorBytes: config.DATABASE_CONSOLE_MAX_ERROR_BYTES,
	};
}

/** The container a driver command of this database runs in. */
function engineTarget(
	ctx: DatabaseContext,
	nonce: string,
	limits: ConsoleLimits,
): EngineTarget {
	return {
		container: container(ctx.app),
		values: valuesOf(ctx.app),
		nonce,
		limits,
	};
}

/** Data size (measured, cached for DATABASE_SIZE_CACHE_MS). */
export async function databaseSize(
	actor: Actor,
	id: string,
): Promise<{ sizeBytes: number | null }> {
	const ctx = await databaseContext(actor, id);
	const cached = sizeCache.get(id);
	if (cached && Date.now() - cached.at < getConfig().DATABASE_SIZE_CACHE_MS) {
		return { sizeBytes: cached.bytes };
	}
	if (
		!deployedServices(ctx.app).includes(DATABASE_SERVICE) ||
		ctx.app.status !== "running"
	) {
		return { sizeBytes: cached?.bytes ?? null };
	}
	const nonce = randomBytes(16).toString("hex");
	const limits = {
		...adminLimits(),
		timeoutMs: getConfig().DATABASE_SIZE_TIMEOUT_MS,
	};
	const engine = serverEngine(ctx.engine);
	const { command, input } = engine.size.probe(
		engineTarget(ctx, nonce, limits),
	);
	const result = await withExecutor(ctx.app, (executor) =>
		runCapped(executor, command, {
			input,
			timeoutMs: limits.timeoutMs + getConfig().DATABASE_EXEC_SLACK_MS,
			nonce,
			limits,
		}),
	).catch(() => null);
	const bytes = result?.exitCode === 0 ? engine.size.parse(result.body) : null;
	if (bytes !== null) sizeCache.set(id, { bytes, at: Date.now() });
	return { sizeBytes: bytes ?? cached?.bytes ?? null };
}

// ---------------------------------------------------------------------------
// Links

/** Links of an app (its databases), for the app page. */
export async function listAppDatabaseLinks(
	actor: Actor,
	appId: string,
): Promise<DatabaseLinkView[]> {
	const app = await getAppRow(actor, appId);
	return linkViews(eq(databaseLinks.appId, app.id));
}

/**
 * Link a database to an app on the same server: the app gets the
 * connection env (on its next deploy, started right away when it runs)
 * and both join a private network created now.
 */
export async function linkDatabase(
	actor: Actor,
	input: LinkDatabaseInput,
): Promise<{ linkId: string; deploymentId: string }> {
	const ctx = await databaseContext(actor, input.databaseId, "database.manage");
	const target = await getAppRow(actor, input.appId, "app.env.edit");
	if (target.templateId === DATABASE_TEMPLATE_ID || target.id === ctx.app.id) {
		throw new AppError("DATABASE_LINK_TARGET_INVALID");
	}
	if (target.serverId !== ctx.app.serverId) {
		throw new AppError("DATABASE_LINK_OTHER_SERVER");
	}
	// The env is stored before a deploy's files are written: a database
	// whose first deploy failed has credentials but was never deployed.
	if (!ctx.app.envEncrypted || !ctx.app.composeDeployed) {
		throw new AppError("DATABASE_NOT_RUNNING");
	}
	if (!!input.username !== !!input.password) {
		throw new AppError("DATABASE_LINK_LOGIN_INCOMPLETE");
	}
	// The main login is the database's superuser: handing it to an app is
	// as strong as writing to the database.
	if (!input.username) assertCanAccess(actor, "database.write");
	const parts = databaseEngines[ctx.engine].linkEnv.parts;
	const env: LinkEnvEntry[] = [
		{ name: input.urlEnv, part: "url" },
		...Object.entries(input.parts)
			.filter(([part]) => part in parts)
			.map(([part, name]) => ({
				name,
				part: part as LinkEnvEntry["part"],
			})),
	];
	const seen = new Set<string>();
	for (const entry of env) {
		try {
			assertLinkEnvName(entry.name);
		} catch {
			throw new AppError("DATABASE_LINK_ENV_INVALID", { name: entry.name });
		}
		if (seen.has(entry.name)) {
			throw new AppError("DATABASE_LINK_ENV_INVALID", { name: entry.name });
		}
		seen.add(entry.name);
	}
	// Names the app already sets (env editor, template) or another link sets.
	const taken = new Set([
		...Object.keys(appInputs(target).overrides),
		...(appInputs(target).templateKeys ?? []),
	]);
	const others = await db
		.select({ env: databaseLinks.env })
		.from(databaseLinks)
		.where(eq(databaseLinks.appId, target.id));
	for (const other of others)
		for (const entry of other.env) taken.add(entry.name);
	for (const entry of env) {
		if (taken.has(entry.name)) {
			throw new AppError("DATABASE_LINK_ENV_CONFLICT", { name: entry.name });
		}
	}
	let link: LinkRow;
	try {
		[link] = await db
			.insert(databaseLinks)
			.values({
				teamId: actor.teamId,
				userId: actor.userId,
				databaseAppId: ctx.app.id,
				appId: target.id,
				env,
				database: input.database ?? null,
				username: input.username ?? null,
				passwordEncrypted: input.password ? encrypt(input.password) : null,
			})
			.returning();
	} catch (error) {
		if (isUniqueViolation(error)) throw new AppError("DATABASE_LINK_EXISTS");
		throw error;
	}
	const network = linkNetworkName(link.id);
	const redeploy = input.redeploy && target.status === "running";
	const { refreshAppFiles, runDeploy, setStatus } = await appJobs();
	try {
		const { deploymentId } = await startJob(
			{
				actor,
				serverId: target.serverId,
				appId: target.id,
				type: "database_link",
				title: jobTitle("database_link", {
					app: target.name,
					database: ctx.app.name,
				}),
			},
			async (job) => {
				const executor = await getExecutor(await getAppServer(target));
				try {
					await ensureLinkNetworks(
						executor,
						[{ name: network, linkId: link.id }],
						await requireInstanceId(),
						job,
					);
					// The database joins now (a stopped container joins on start).
					const joined = await executor.exec(
						connectNetworkCommand(network, container(ctx.app)),
					);
					if (joined.exitCode !== 0) {
						throw new AppError("DATABASE_LINK_ATTACH_FAILED", {
							network,
							detail: joined.stderr || joined.stdout,
						});
					}
					job.event("link.joined", { database: ctx.app.name, network });
					// Its networks file lists it too (re-attached after every up).
					await refreshAppFiles(executor, ctx.app.id, job);
				} finally {
					executor.close();
				}
				await setStatus(target.id, { needsRedeploy: true });
				if (!redeploy) {
					job.event("link.done", { app: target.name });
					return { success: true };
				}
				job.event("link.redeploying", { app: target.name });
				return runDeploy(
					target.id,
					target.commitSha ? "redeploy" : "deploy",
					undefined,
					job,
				);
			},
		);
		audit({
			actor,
			action: "database.link",
			targetType: "app",
			targetId: ctx.app.id,
			meta: { appId: target.id, env: env.map((entry) => entry.name) },
		});
		return { linkId: link.id, deploymentId };
	} catch (error) {
		await db.delete(databaseLinks).where(eq(databaseLinks.id, link.id));
		throw error;
	}
}

/**
 * Remove a link: the database leaves the link network at once (the app
 * can't reach it any more), the app loses the env on its redeploy (started
 * now when it runs), then the network is removed.
 */
export async function unlinkDatabase(
	actor: Actor,
	input: { linkId: string; redeploy: boolean },
): Promise<{ deploymentId: string }> {
	const [link] = await db
		.select()
		.from(databaseLinks)
		.where(eq(databaseLinks.id, input.linkId))
		.limit(1);
	const owned = assertCanAccess(
		actor,
		link,
		"database.manage",
		"DATABASE_NOT_FOUND",
	);
	const ctx = await databaseContext(
		actor,
		owned.databaseAppId,
		"database.manage",
	);
	const target = await getAppRow(actor, owned.appId, "app.env.edit");
	const network = linkNetworkName(owned.id);
	const redeploy = input.redeploy && target.status === "running";
	const { refreshAppFiles, runDeploy, setStatus } = await appJobs();
	const { deploymentId } = await startJob(
		{
			actor,
			serverId: target.serverId,
			appId: target.id,
			type: "database_unlink",
			title: jobTitle("database_unlink", {
				app: target.name,
				database: ctx.app.name,
			}),
		},
		async (job) => {
			await db.delete(databaseLinks).where(eq(databaseLinks.id, owned.id));
			await setStatus(target.id, { needsRedeploy: true });
			const executor = await getExecutor(await getAppServer(target));
			try {
				await executor.exec(
					disconnectNetworkCommand(network, container(ctx.app)),
				);
				job.event("unlink.left", {
					database: ctx.app.name,
					network,
					app: target.name,
				});
				// The database's files stop naming the link network.
				await refreshAppFiles(executor, ctx.app.id, job);
				if (!redeploy) {
					// The app's files too: no env file, no network at its next
					// `up`. The network stays until then (a stopped container
					// still names it), the cleanup after deploys removes it.
					await refreshAppFiles(executor, target.id, job);
					job.event("unlink.done", { app: target.name });
					return { success: true };
				}
				job.event("unlink.redeploying", { app: target.name });
				const outcome = await runDeploy(
					target.id,
					target.commitSha ? "redeploy" : "deploy",
					undefined,
					job,
				);
				if (outcome.success) {
					await executor.exec(removeLinkNetworkCommand(network));
					job.event("unlink.network_removed", { network });
				}
				return outcome;
			} catch (error) {
				return { success: false, error };
			} finally {
				executor.close();
			}
		},
	);
	audit({
		actor,
		action: "database.unlink",
		targetType: "app",
		targetId: ctx.app.id,
		meta: { appId: target.id },
	});
	return { deploymentId };
}

// ---------------------------------------------------------------------------
// Console

function consoleLimits(): ConsoleLimits {
	const config = getConfig();
	return {
		timeoutMs: config.DATABASE_CONSOLE_TIMEOUT_MS,
		maxBytes: config.DATABASE_CONSOLE_MAX_OUTPUT_BYTES,
		maxErrorBytes: config.DATABASE_CONSOLE_MAX_ERROR_BYTES,
	};
}

/**
 * Console runs per member/token (one instance, in memory): at most
 * DATABASE_CONSOLE_CONCURRENCY at once and DATABASE_CONSOLE_RATE_PER_MINUTE
 * per minute.
 */
const consoleRuns = new Map<string, { running: number; starts: number[] }>();

function consoleSlot(actor: Actor): () => void {
	const config = getConfig();
	const key = actor.tokenId
		? `token:${actor.tokenId}`
		: `user:${actor.userId ?? actor.teamId}`;
	const now = Date.now();
	const entry = consoleRuns.get(key) ?? { running: 0, starts: [] };
	entry.starts = entry.starts.filter((at) => now - at < 60_000);
	if (
		entry.running >= config.DATABASE_CONSOLE_CONCURRENCY ||
		entry.starts.length >= config.DATABASE_CONSOLE_RATE_PER_MINUTE
	) {
		throw new AppError("DATABASE_CONSOLE_BUSY");
	}
	entry.running++;
	entry.starts.push(now);
	consoleRuns.set(key, entry);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		entry.running--;
		if (entry.running <= 0 && entry.starts.length === 0)
			consoleRuns.delete(key);
	};
}

/**
 * Run console input. Read-only (database.manage): reading statements only,
 * as the read-only login in a READ ONLY transaction. Write mode
 * (database.write): as the superuser, every statement audited (literals
 * hidden). Output and error output are capped in the container and never
 * buffered beyond the limits here.
 */
export async function runConsole(
	actor: Actor,
	input: ConsoleRunInput,
): Promise<ConsoleResult> {
	const ctx = await databaseContext(
		actor,
		input.databaseId,
		input.write ? "database.write" : "database.manage",
	);
	assertRunning(ctx.app);
	const config = getConfig();
	const limits = consoleLimits();
	const readOnly = !input.write;
	const nonce = randomBytes(16).toString("hex");
	const engine = serverEngine(ctx.engine);
	const database = input.database ?? mainLogin(ctx).database;
	// Input refusals are coded (ConsoleRefusal, TemplateError): thrown as is.
	const plan = engine.console.prepare(engineTarget(ctx, nonce, limits), {
		text: input.input,
		database,
		readOnly,
		maxBytes: config.DATABASE_CONSOLE_MAX_INPUT_BYTES,
		scanMaxCount: config.DATABASE_CONSOLE_SCAN_MAX_COUNT,
	});
	const release = consoleSlot(actor);
	try {
		if (!readOnly) {
			for (const statement of plan.audited) {
				audit({
					actor,
					action: "database.console.write",
					targetType: "app",
					targetId: ctx.app.id,
					meta: { database: database ?? null, statement },
				});
			}
		}
		if (readOnly && engine.console.beforeReadOnly) {
			await adminSql(ctx, engine.console.beforeReadOnly());
		}
		const started = Date.now();
		const output = await withExecutor(ctx.app, (executor) =>
			runCapped(executor, plan.command, {
				input: plan.input,
				timeoutMs: limits.timeoutMs + config.DATABASE_EXEC_SLACK_MS,
				nonce,
				limits,
			}),
		);
		return consoleResult(ctx, output, nonce, Date.now() - started);
	} finally {
		release();
	}
}

function consoleResult(
	ctx: DatabaseContext,
	output: CappedRun,
	nonce: string,
	durationMs: number,
): ConsoleResult {
	const engine = serverEngine(ctx.engine);
	// exitCode null: the output was cut off (a large result), not a failure.
	const failed = output.exitCode !== null && output.exitCode !== 0;
	const base: ConsoleResult = {
		kind: "none",
		columns: [],
		rows: [],
		text: "",
		truncated: output.truncated,
		error: null,
		durationMs,
	};
	if (failed) {
		const message =
			engine.formatError(output.stderr || output.body) ||
			`exit ${output.exitCode ?? "?"}`;
		// The error line(s) with their context, not the notices before them.
		const lines = message.split("\n");
		const first = lines.findIndex((line) =>
			/^(ERROR|FATAL|PANIC)\b|^ERROR \d+/.test(line),
		);
		return {
			...base,
			error:
				first === -1
					? clipEnd(message, TEXT_LIMITS.consoleError)
					: clip(lines.slice(first).join("\n"), TEXT_LIMITS.consoleError),
		};
	}
	const outcome = engine.console.outcome(
		output.body,
		nonce,
		getConfig().DATABASE_CONSOLE_MAX_ROWS,
	);
	switch (outcome.kind) {
		case "error":
			return { ...base, error: outcome.error };
		case "grid":
			return {
				...base,
				kind: "grid",
				columns: outcome.columns,
				rows: outcome.rows,
				truncated: outcome.truncated || output.truncated,
			};
		default:
			return { ...base, kind: outcome.kind, text: outcome.text };
	}
}

// ---------------------------------------------------------------------------
// Users and databases (engines with an admin driver)

function adminOf(ctx: DatabaseContext): EngineAdmin {
	const admin = serverEngine(ctx.engine).admin;
	if (!databaseEngines[ctx.engine].manageUsers || !admin) {
		throw new AppError("DATABASE_UNSUPPORTED");
	}
	return admin;
}

/**
 * Run admin SQL (generated by Nitrobase from validated names) as the
 * superuser/root, on stdin, output capped; throws SQL_ERROR with the
 * client's message.
 */
async function adminSql(
	ctx: DatabaseContext,
	sql: string,
	database?: string,
): Promise<string> {
	const engine = serverEngine(ctx.engine);
	const admin = engine.admin;
	if (!admin) throw new AppError("DATABASE_UNSUPPORTED");
	const limits = adminLimits();
	const nonce = randomBytes(16).toString("hex");
	const command = admin.command(engineTarget(ctx, nonce, limits), database);
	const input = /;\s*$/.test(sql) ? sql : `${sql};`;
	const result = await withExecutor(ctx.app, (executor) =>
		runCapped(executor, command, {
			input: `${input}\n`,
			timeoutMs: limits.timeoutMs + getConfig().DATABASE_EXEC_SLACK_MS,
			nonce,
			limits,
		}),
	);
	if (result.exitCode !== 0) {
		const message =
			clip(
				engine.formatError(result.stderr || result.body),
				TEXT_LIMITS.storedError,
			) || `exit ${result.exitCode ?? "?"}`;
		throw new AppError("SQL_ERROR", { message });
	}
	return result.body;
}

/** Run admin steps in order (coded name errors are thrown as they are). */
async function adminSteps(
	ctx: DatabaseContext,
	build: () => AdminStep[],
): Promise<void> {
	for (const step of build()) await adminSql(ctx, step.sql, step.database);
}

/** Logins and databases a link to this database uses (not droppable). */
async function linkedNames(
	databaseAppId: string,
): Promise<{ users: Set<string>; databases: Set<string> }> {
	const rows = await db
		.select({
			username: databaseLinks.username,
			database: databaseLinks.database,
		})
		.from(databaseLinks)
		.where(eq(databaseLinks.databaseAppId, databaseAppId));
	return {
		users: new Set(rows.flatMap((row) => (row.username ? [row.username] : []))),
		databases: new Set(
			rows.flatMap((row) => (row.database ? [row.database] : [])),
		),
	};
}

export async function listDatabaseUsers(
	actor: Actor,
	id: string,
): Promise<UsersView> {
	const ctx = await databaseContext(actor, id, "database.manage");
	const admin = adminOf(ctx);
	assertRunning(ctx.app);
	const main = mainNames(ctx);
	const stdout = await adminSql(ctx, admin.listSql());
	let parsed: {
		databases: { name: string; owner?: string; sizeBytes: number | string }[];
		users: {
			name: string;
			host?: string;
			superuser?: boolean;
			login?: boolean;
		}[];
	};
	try {
		parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
	} catch {
		throw new AppError("SQL_OUTPUT_UNEXPECTED");
	}
	const linked = await linkedNames(ctx.app.id);
	return {
		databases: (parsed.databases ?? []).map((item) => ({
			name: item.name,
			owner: item.owner,
			sizeBytes: Number(item.sizeBytes) || 0,
			protected: admin.isProtected("database", item.name, main),
			linked: linked.databases.has(item.name),
		})),
		users: (parsed.users ?? [])
			.map((item) => ({
				...item,
				linked: linked.users.has(item.name),
				protected: admin.isProtected("user", item.name, main),
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

/** The main login's user and database (never dropped). */
function mainNames(ctx: DatabaseContext): { user: string; database: string } {
	const login = mainLogin(ctx);
	return { user: login.user ?? "", database: login.database ?? "" };
}

function adminAudit(
	actor: Actor,
	ctx: DatabaseContext,
	action:
		| "database.db.create"
		| "database.db.drop"
		| "database.user.create"
		| "database.user.drop"
		| "database.grant",
	meta: Record<string, unknown>,
) {
	audit({ actor, action, targetType: "app", targetId: ctx.app.id, meta });
}

export async function createManagedDatabase(
	actor: Actor,
	input: { databaseId: string; name: string; owner?: string },
): Promise<void> {
	const ctx = await databaseContext(actor, input.databaseId, "database.manage");
	const admin = adminOf(ctx);
	assertRunning(ctx.app);
	await adminSteps(ctx, () =>
		admin.createDatabase(input.name, input.owner ?? null),
	);
	adminAudit(actor, ctx, "database.db.create", { name: input.name });
}

/** Create a login with a generated password (returned once, never stored). */
export async function createManagedUser(
	actor: Actor,
	input: { databaseId: string; name: string; grantDatabase?: string },
): Promise<{ password: string }> {
	const ctx = await databaseContext(actor, input.databaseId, "database.manage");
	// Logins and drops: database.write too (S6).
	assertCanAccess(actor, "database.write");
	const admin = adminOf(ctx);
	assertRunning(ctx.app);
	if (serverEngine(ctx.engine).reservedUsers.includes(input.name)) {
		throw new AppError("DATABASE_NAME_PROTECTED", { name: input.name });
	}
	const password = generatePassword(getConfig().DATABASE_USER_PASSWORD_LENGTH);
	assertManagedUser(input.name);
	if (input.grantDatabase) assertManagedDatabase(input.grantDatabase);
	await adminSteps(ctx, () => [
		...admin.createUser(input.name, password),
		...(input.grantDatabase
			? admin.grant(input.grantDatabase, input.name)
			: []),
	]);
	adminAudit(actor, ctx, "database.user.create", {
		name: input.name,
		grantDatabase: input.grantDatabase ?? null,
	});
	return { password };
}

export async function grantDatabase(
	actor: Actor,
	input: { databaseId: string; user: string; host?: string; database: string },
): Promise<void> {
	const ctx = await databaseContext(actor, input.databaseId, "database.manage");
	// Logins and drops: database.write too (S6).
	assertCanAccess(actor, "database.write");
	const admin = adminOf(ctx);
	assertRunning(ctx.app);
	await adminSteps(ctx, () =>
		admin.grant(input.database, input.user, input.host),
	);
	adminAudit(actor, ctx, "database.grant", {
		user: input.user,
		database: input.database,
	});
}

/** Drop a database or user (typed confirmation; protected names refused). */
export async function dropManaged(
	actor: Actor,
	input: {
		databaseId: string;
		kind: "database" | "user";
		name: string;
		host?: string;
		confirm: string;
	},
): Promise<void> {
	const ctx = await databaseContext(actor, input.databaseId, "database.manage");
	// Logins and drops: database.write too (S6).
	assertCanAccess(actor, "database.write");
	const admin = adminOf(ctx);
	assertRunning(ctx.app);
	if (input.confirm !== input.name)
		throw new AppError("DATABASE_CONFIRM_MISMATCH");
	if (admin.isProtected(input.kind, input.name, mainNames(ctx))) {
		throw new AppError("DATABASE_NAME_PROTECTED", { name: input.name });
	}
	const linked = await linkedNames(ctx.app.id);
	if (
		(input.kind === "database" ? linked.databases : linked.users).has(
			input.name,
		)
	) {
		throw new AppError("DATABASE_NAME_LINKED", { name: input.name });
	}
	await adminSteps(ctx, () =>
		input.kind === "database"
			? admin.dropDatabase(input.name)
			: admin.dropUser(input.name, input.host),
	);
	adminAudit(
		actor,
		ctx,
		input.kind === "database" ? "database.db.drop" : "database.user.drop",
		{ name: input.name },
	);
}
