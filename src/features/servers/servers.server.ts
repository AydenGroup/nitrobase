import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DATABASE_TEMPLATE_ID } from "#/config/database-engines.ts";
import { BASE_PACKAGES } from "#/config/host-os.ts";
import type { JobStep } from "#/config/job-log-events.ts";
import { jobTitle } from "#/config/job-titles.ts";
import type { Permission } from "#/config/permissions.ts";
import { getConfig, hostPaths, traefikVersion } from "#/config/server.ts";
import { APP_ID, LOCAL_SERVER } from "#/config/shared.ts";
import { DEFAULT_SSH_KEY_TYPE } from "#/config/ssh-key-types.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { deployments, servers } from "#/db/schema/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess } from "#/features/auth/access.ts";
import type { JobLogger } from "#/features/deployments/deployments.server.ts";
import {
	isServerBusy,
	type JobContext,
	type JobOutcome,
	recoverOrphanedJobs,
	startJob,
} from "#/features/deployments/deployments.server.ts";
import { serverHealthSummaries } from "#/features/monitoring/service.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import {
	createSSHKey,
	deleteSSHKey,
	getSSHKeyCredentials,
} from "#/features/ssh_keys/ssh_keys.server.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { audit } from "#/server/services/audit.ts";
import { errorInfoOf, lastErrorColumns } from "#/server/services/error-info.ts";
import type { Executor } from "#/server/services/executor.ts";
import { LocalExecutor } from "#/server/services/local.ts";
import {
	assertServerUsable,
	type BootstrapResult,
	bootstrapServer,
	installManagedKey,
	parseDockerVersion,
	parseKeyValueLines,
	probeServerOwnership,
	ServerManagedElsewhereError,
	systemInfoScript,
} from "#/server/services/server-setup.ts";
import {
	HostKeyMismatchError,
	type HostKeyPolicy,
	type SSHConnection,
	SshConnectionError,
	SshExecutor,
	testConnection,
} from "#/server/services/ssh.ts";
import { generateSSHKey } from "#/server/services/ssh-keygen.ts";
import { decrypt, encrypt } from "#/utils/crypto.ts";
import { AppError } from "#/utils/error.ts";
import type {
	BootstrapPreview,
	DeploymentDTO,
	ServerDTO,
	ServerInput,
	ServerResourcePolicyInput,
	ServerRow,
	ServerSummaries,
	ServerSummary,
	ServerUpdateInput,
	TestServerCredentialsInput,
} from "./schema";
import { convergeTunnel } from "./tunnel.server";

/**
 * Columns safe to return to clients: everything except the encrypted
 * password. Use with `select()`/`returning()` to build a `ServerDTO`.
 */
const dtoColumns = {
	id: servers.id,
	teamId: servers.teamId,
	userId: servers.userId,
	name: servers.name,
	host: servers.host,
	port: servers.port,
	username: servers.username,
	authMethod: servers.authMethod,
	sshKeyId: servers.sshKeyId,
	hostKeyFingerprint: servers.hostKeyFingerprint,
	isDefault: servers.isDefault,
	status: servers.status,
	os: servers.os,
	dockerVersion: servers.dockerVersion,
	traefikVersion: servers.traefikVersion,
	lastError: servers.lastError,
	lastErrorCode: servers.lastErrorCode,
	lastErrorParams: servers.lastErrorParams,
	tunnelEnabled: servers.tunnelEnabled,
	tunnelOnly: servers.tunnelOnly,
	tunnelConfigured: sql<boolean>`${servers.tunnelTokenEncrypted} is not null`,
	requireLimits: servers.requireLimits,
	defaultMemoryMb: servers.defaultMemoryMb,
	createdAt: servers.createdAt,
	updatedAt: servers.updatedAt,
} as const;

const dtoDeploymentColumns = {
	id: deployments.id,
	teamId: deployments.teamId,
	userId: deployments.userId,
	serverId: deployments.serverId,
	appId: deployments.appId,
	status: deployments.status,
	type: deployments.type,
	title: deployments.title,
	titleKey: deployments.titleKey,
	titleParams: deployments.titleParams,
	errorMessage: deployments.errorMessage,
	errorCode: deployments.errorCode,
	errorParams: deployments.errorParams,
	warningCount: deployments.warningCount,
	commitSha: deployments.commitSha,
	createdAt: deployments.createdAt,
	updatedAt: deployments.updatedAt,
} as const;

/** Servers owned by `userId`, newest first (client-safe DTOs). */
export async function listServers(actor: Actor): Promise<ServerDTO[]> {
	const rows = await db
		.select(dtoColumns)
		.from(servers)
		.where(eq(servers.teamId, actor.teamId))
		.orderBy(desc(servers.createdAt));
	return rows;
}

/** App counts and latest health of the caller's servers (server list). */
export async function listServerSummaries(
	actor: Actor,
): Promise<ServerSummaries> {
	const config = getConfig();
	const thresholds = {
		diskPercent: config.ALERT_DISK_PERCENT,
		memoryPercent: config.ALERT_MEMORY_PERCENT,
	};
	const rows = await db
		.select({ id: servers.id })
		.from(servers)
		.where(eq(servers.teamId, actor.teamId));
	const ids = rows.map((row) => row.id);
	if (ids.length === 0) return { servers: [], thresholds };
	const [counts, health] = await Promise.all([
		db
			.select({
				serverId: apps.serverId,
				databases:
					sql<number>`count(*) filter (where ${apps.templateId} = ${DATABASE_TEMPLATE_ID})`.mapWith(
						Number,
					),
				total: sql<number>`count(*)`.mapWith(Number),
			})
			.from(apps)
			.where(and(eq(apps.teamId, actor.teamId), inArray(apps.serverId, ids)))
			.groupBy(apps.serverId),
		serverHealthSummaries(ids),
	]);
	const byServer = new Map(counts.map((row) => [row.serverId, row]));
	const healthOf = new Map(health.map((item) => [item.serverId, item]));
	return {
		thresholds,
		servers: ids.map((serverId): ServerSummary => {
			const count = byServer.get(serverId);
			return {
				serverId,
				appCount: (count?.total ?? 0) - (count?.databases ?? 0),
				databaseCount: count?.databases ?? 0,
				health: healthOf.get(serverId) ?? null,
			};
		}),
	};
}

/** One server scoped to its owner; null when missing or owned by someone else. */
export async function getServer(
	actor: Actor,
	serverId: string,
): Promise<ServerDTO | null> {
	const row = await db
		.select(dtoColumns)
		.from(servers)
		.where(and(eq(servers.id, serverId), eq(servers.teamId, actor.teamId)))
		.limit(1);

	return row[0] ?? null;
}

/**
 * Inserts a server owned by `userId`. Passwords are encrypted at rest; only
 * the credential matching `authMethod` is stored. Writes an audit entry.
 */
export async function createServer(
	actor: Actor,
	data: ServerInput,
): Promise<ServerDTO> {
	const usesKey = data.authMethod === "private_key";
	if (usesKey && data.sshKeyId) {
		// Ensures the key exists and belongs to the user.
		await getSSHKeyCredentials(actor, data.sshKeyId);
	}

	const [row] = await db
		.insert(servers)
		.values({
			teamId: actor.teamId,
			userId: actor.userId,
			name: data.name,
			host: data.host,
			port: data.port,
			username: data.username,
			authMethod: data.authMethod,
			sshKeyId: usesKey ? (data.sshKeyId ?? null) : null,
			passwordEncrypted:
				!usesKey && data.password ? encrypt(data.password) : null,
		})
		.returning(dtoColumns);
	audit({
		actor,
		action: "server.create",
		targetType: "server",
		targetId: row.id,
		meta: { name: row.name, host: row.host, authMethod: row.authMethod },
	});
	// Check the connection right away (job): the server page then shows
	// Reachable/Unreachable instead of "not checked yet".
	await startServerAction(actor, row.id, "connection_test", "").catch(
		() => null,
	);
	return row;
}

/**
 * Partial update of an owned server: undefined fields are left untouched,
 * and switching auth method clears the other method's credential. A new
 * host or port is a different machine: its trusted host key is forgotten
 * and it goes back to `pending` until tested and bootstrapped (a Ready
 * status was earned by the old address). Refused while a job runs on the
 * server. Writes audit entries.
 */
export async function updateServer(
	actor: Actor,
	serverId: string,
	data: ServerUpdateInput,
): Promise<ServerDTO> {
	if (isServerBusy(serverId)) throw new AppError("SERVER_BUSY");
	if (data.authMethod === "private_key" && data.sshKeyId) {
		await getSSHKeyCredentials(actor, data.sshKeyId);
	}
	const current = await getServerRow(actor, serverId, "server.manage");
	if (
		data.authMethod === "password" &&
		!data.password &&
		!current.isDefault &&
		!current.passwordEncrypted
	) {
		throw new AppError("SERVER_PASSWORD_REQUIRED");
	}
	// A new address is a different machine: forget the trusted host key.
	const targetChanged =
		(data.host !== undefined && data.host !== current.host) ||
		(data.port !== undefined && data.port !== current.port);

	const [row] = await db
		.update(servers)
		.set({
			...(targetChanged && {
				hostKeyFingerprint: null,
				status: "pending" as const,
				...lastErrorColumns(null),
			}),
			...(data.name !== undefined && { name: data.name }),
			...(data.host !== undefined && { host: data.host }),
			...(data.port !== undefined && { port: data.port }),
			...(data.username !== undefined && { username: data.username }),
			...(data.authMethod !== undefined && { authMethod: data.authMethod }),
			...(data.authMethod === "private_key" && { passwordEncrypted: null }),
			// Only touch the key when one was sent; partial updates keep it.
			...(data.authMethod === "private_key" &&
				data.sshKeyId !== undefined && { sshKeyId: data.sshKeyId }),
			...(data.authMethod === "password" && { sshKeyId: null }),
			...(data.password && { passwordEncrypted: encrypt(data.password) }),
			updatedAt: new Date(),
		})
		.where(and(eq(servers.id, serverId), eq(servers.teamId, actor.teamId)))
		.returning(dtoColumns);
	if (!row) {
		throw new AppError("SERVER_NOT_FOUND");
	}
	audit({
		actor,
		action: "server.update",
		targetType: "server",
		targetId: serverId,
		meta: {
			fields: Object.keys(data).filter((key) => key !== "password"),
			authUpdated: !!data.password || data.sshKeyId !== undefined,
		},
	});
	if (targetChanged) {
		audit({
			actor,
			action: "server.address.change",
			targetType: "server",
			targetId: serverId,
			meta: { host: row.host, port: row.port, hostKeyReset: true },
		});
	}
	return row;
}

/**
 * Deletes an owned server. The default (local) server, servers with a
 * running job and servers that still host apps cannot be deleted.
 */
export async function deleteServer(
	actor: Actor,
	serverId: string,
): Promise<void> {
	const server = await getServer(actor, serverId);
	if (!server) throw new AppError("SERVER_NOT_FOUND");
	if (server.isDefault) throw new AppError("CANNOT_DELETE_DEFAULT_SERVER");
	if (isServerBusy(serverId)) throw new AppError("SERVER_BUSY");
	const [app] = await db
		.select({ id: apps.id })
		.from(apps)
		.where(eq(apps.serverId, serverId))
		.limit(1);
	if (app) throw new AppError("SERVER_HAS_APPS");

	const result = await db
		.delete(servers)
		.where(and(eq(servers.id, serverId), eq(servers.teamId, actor.teamId)))
		.returning({ id: servers.id });
	if (!result[0]) {
		throw new AppError("SERVER_NOT_FOUND");
	}
	audit({
		actor,
		action: "server.delete",
		targetType: "server",
		targetId: serverId,
	});
}

/** The default (local) server of a new account; see `LOCAL_SERVER`. */
export async function createDefaultServer(
	actor: Pick<Actor, "teamId" | "userId">,
	tx: Pick<typeof db, "insert"> = db,
): Promise<ServerDTO> {
	const [row] = await tx
		.insert(servers)
		.values({
			teamId: actor.teamId,
			userId: actor.userId,
			...LOCAL_SERVER,
			authMethod: "password",
			passwordEncrypted: null,
			sshKeyId: null,
			isDefault: true,
			status: "pending",
		})
		.returning(dtoColumns);
	return row;
}

export type ServerAction = "bootstrap" | "connection_test";

const PROBE_SCRIPT = [
	`echo os=$( (grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null || echo "PRETTY_NAME=$(uname -sr)") | head -1 | cut -d= -f2 | tr -d '"')`,
	"echo docker=$(docker --version 2>/dev/null)",
].join("\n");

/** Every Ready server (all owners): background work such as sweeps and monitoring. */
export async function listReadyServers(): Promise<ServerRow[]> {
	return db.select().from(servers).where(eq(servers.status, "ready"));
}

/**
 * Full server row (credentials included) of the actor's team; server-only.
 * `permission` is what the caller is about to do with it.
 */
export async function getServerRow(
	actor: Actor,
	serverId: string,
	permission: Permission = "server.view",
): Promise<ServerRow> {
	const [row] = await db
		.select()
		.from(servers)
		.where(eq(servers.id, serverId))
		.limit(1);
	return assertCanAccess(actor, row, permission, "SERVER_NOT_FOUND");
}
/**
 * Executor for a server row: the default server runs on this host, others
 * over one reused SSH connection. Callers must `close()` it.
 */
export async function getExecutor(row: ServerRow): Promise<Executor> {
	if (row.isDefault) return new LocalExecutor();
	return new SshExecutor(await resolveSSHConnection(row));
}

/**
 * Start a server action as a background job. Returns immediately with the
 * deployment id; progress is streamed via /api/deployments/:id/stream.
 */
export async function startServerAction(
	actor: Actor,
	serverId: string,
	action: ServerAction,
	acmeEmail: string,
	options: { takeover?: boolean } = {},
): Promise<{ deploymentId: string }> {
	const server = await getServerRow(actor, serverId, "server.manage");
	const takeover = action === "bootstrap" && !!options.takeover;
	// Taking a server over from another instance: instance admins only.
	if (takeover) assertCanAccess(actor, "instance.manage");
	audit({
		actor,
		action: `server.${action}`,
		targetType: "server",
		targetId: serverId,
	});
	if (takeover) {
		audit({
			actor,
			action: "server.takeover",
			targetType: "server",
			targetId: serverId,
		});
	} else if (action === "bootstrap") {
		// Refuse up front (the job checks again before changing anything).
		const probe = await getExecutor(server).catch(() => null);
		if (probe) {
			try {
				const ownership = await probeServerOwnership(
					probe,
					await requireInstanceId(),
				);
				assertServerUsable(ownership);
			} catch (error) {
				if (error instanceof AppError) throw error;
				// Unreachable: the job reports the connection problem.
			} finally {
				probe.close();
			}
		}
	}
	const target = `${server.username}@${server.host}:${server.port}`;

	if (action === "connection_test") {
		return startJob(
			{
				actor,
				serverId,
				type: "connection_test",
				title: server.isDefault
					? jobTitle("connection_test_local")
					: jobTitle("connection_test", { target }),
			},
			(ctx) => runConnectionTest(server, ctx),
		);
	}

	return startJob(
		{
			actor,
			serverId,
			type: "bootstrap",
			title: jobTitle("bootstrap"),
		},
		(ctx) => runBootstrap(actor, server, acmeEmail, ctx, takeover),
	);
}

export async function previewBootstrap(
	actor: Actor,
	serverId: string,
): Promise<BootstrapPreview> {
	const server = await getServerRow(actor, serverId, "server.manage");
	const config = getConfig();
	const base: BootstrapPreview = {
		reachable: false,
		error: null,
		managedKey: !server.isDefault && server.authMethod === "password",
		tunnelOnly: server.tunnelOnly,
		dockerVersion: null,
		dockerInstalled: null,
		traefikExists: null,
		portsBusy: [],
		foreignOwner: null,
		canTakeOver: actor.instanceAdmin,
		unclaimedTraefik: false,
		packages: [...BASE_PACKAGES],
		networks: [config.NITROBASE_NETWORK, config.TUNNEL_NETWORK],
		traefikContainer: config.TRAEFIK_CONTAINER,
		root: hostPaths(config).root,
	};
	let executor: Executor | null = null;
	try {
		executor = await getExecutor(server);
		const probe = await executor.exec(systemInfoScript());
		const values = parseKeyValueLines(probe.stdout);
		const ownership = await probeServerOwnership(
			executor,
			await requireInstanceId(),
		);
		const traefikExists = !!values.traefik && values.traefik !== "missing";
		const dockerInstalled =
			!!values.docker && values.docker !== "not_installed";
		return {
			...base,
			reachable: true,
			dockerInstalled,
			dockerVersion: dockerInstalled ? parseDockerVersion(values.docker) : null,
			traefikExists,
			portsBusy:
				traefikExists || server.tunnelOnly
					? []
					: [
							...(values.port80 === "used" ? [80] : []),
							...(values.port443 === "used" ? [443] : []),
						],
			foreignOwner: ownership.foreign[0] ?? null,
			// A Traefik nobody marked as theirs, on a server where this
			// database has no app: maybe another (older) panel's.
			unclaimedTraefik:
				traefikExists &&
				!ownership.claimed &&
				ownership.foreign.length === 0 &&
				(
					await db
						.select({ id: apps.id })
						.from(apps)
						.where(eq(apps.serverId, server.id))
						.limit(1)
				).length === 0,
			packages: [...BASE_PACKAGES],
		};
	} catch (error) {
		return { ...base, error: errorInfoOf(connectionError(server, error)) };
	} finally {
		executor?.close();
	}
}

async function runConnectionTest(
	server: ServerRow,
	ctx: JobContext,
): Promise<JobOutcome> {
	let outcome: JobOutcome;
	let dockerVersion: string | null = null;
	let os: string | null = null;
	if (server.isDefault) ctx.event("server.checking_local");
	else {
		ctx.event("server.connecting", {
			target: `${server.username}@${server.host}:${server.port}`,
		});
	}
	let executor: Executor | null = null;
	try {
		executor = await getExecutor(server);
		const probe = await executor.exec(PROBE_SCRIPT);
		const values = parseKeyValueLines(probe.stdout);
		os = values.os || null;
		dockerVersion = parseDockerVersion(values.docker ?? "");
		ctx.event(server.isDefault ? "server.local_reachable" : "server.reachable");
		if (os) ctx.event("server.os", { os });
		if (dockerVersion)
			ctx.event("server.docker_found", { version: dockerVersion });
		else ctx.event("server.docker_missing");
		outcome = { success: true };
	} catch (error) {
		const failure = connectionError(server, error);
		outcome = { success: false, error: failure };
		ctx.event("job.error", { error: { $error: errorInfoOf(failure) } });
	} finally {
		executor?.close();
	}

	// Status model: a test never changes "ready"/"bootstrapping" (only
	// bootstrap does); it moves the others to reachable/unreachable. A
	// failure is still recorded in last_error (shown as a warning on a
	// Ready server).
	const keep = server.status === "ready" || server.status === "bootstrapping";
	await db
		.update(servers)
		.set({
			...(outcome.success
				? {
						...lastErrorColumns(null),
						...(!keep && { status: "reachable" as const }),
						...(dockerVersion && { dockerVersion }),
						...(os && { os }),
					}
				: {
						...(!keep && { status: "unreachable" as const }),
						...lastErrorColumns(outcome.error),
					}),
			updatedAt: new Date(),
		})
		.where(eq(servers.id, server.id));
	return outcome;
}

/** The server could not be reached or verified (no command ran). */
function isConnectionFailure(error: unknown): boolean {
	return (
		error instanceof SshConnectionError || error instanceof HostKeyMismatchError
	);
}

/** Actionable (coded) error for a failed SSH connection. */
function connectionError(server: ServerRow, error: unknown): unknown {
	if (server.isDefault || !(error instanceof SshConnectionError)) return error;
	const reason = error.reason.replace(/\.+$/, "");
	if (/authentication methods failed/i.test(reason)) {
		return new AppError("SSH_LOGIN_REJECTED", { detail: reason });
	}
	return new AppError("SSH_CONNECTION_HINT", { detail: reason });
}

async function runBootstrap(
	actor: Actor,
	row: ServerRow,
	acmeEmail: string,
	ctx: JobContext,
	takeover = false,
): Promise<JobOutcome> {
	await db
		.update(servers)
		.set({
			status: "bootstrapping",
			...lastErrorColumns(null),
			updatedAt: new Date(),
		})
		.where(eq(servers.id, row.id));

	if (row.isDefault) ctx.event("server.bootstrap_local", { server: row.name });
	else {
		ctx.event("server.bootstrap_remote", { server: row.name, host: row.host });
	}

	let result: BootstrapResult;
	let executor: Executor | null = null;
	// Set before the first step that may change the server.
	let changing = false;
	try {
		ctx.setCancelState?.("bootstrap_partial");
		const critical =
			ctx.critical ?? (<T>(_label: JobStep, step: () => Promise<T>) => step());
		const instanceId = await requireInstanceId();
		// Before changing anything (even the SSH key): is this server
		// managed by another Nitrobase instance?
		{
			const probe = await getExecutor(row);
			try {
				const ownership = await probeServerOwnership(probe, instanceId);
				assertServerUsable(ownership, { takeover });
			} finally {
				probe.close();
			}
		}
		const appFolders = (
			await db
				.select({ folder: apps.folder })
				.from(apps)
				.where(eq(apps.serverId, row.id))
		).map((app) => app.folder);
		// From here on the server may change (managed key installed in
		// authorized_keys, then bootstrap's own steps).
		changing = true;
		const server =
			!row.isDefault && row.authMethod === "password"
				? // Key install → verify → password removal must not stop half-way.
					await critical("managed_key_install", () =>
						switchToManagedKey(actor, row, ctx),
					)
				: row;
		executor = await getExecutor(server);
		result = await bootstrapServer(executor, acmeEmail, ctx, {
			signal: ctx.signal,
			critical,
			// Tunnel-only servers need no open 80/443 (see Cloudflare Tunnel).
			tunnelOnly: server.tunnelOnly,
			owner: { instanceId, appFolders, takeover },
		});
		if (result.success && server.tunnelEnabled) {
			await convergeTunnel(executor, server, ctx, ctx.signal);
		}
	} catch (error) {
		ctx.event("job.error", { error: { $error: errorInfoOf(error) } });
		result = {
			success: false,
			steps: [],
			error,
			os: null,
			dockerVersion: null,
			// Thrown by the ownership probe (unchanged), the key switch or the
			// tunnel step (maybe changed); bootstrapServer reports its own.
			changed: changing,
			foreignOwner:
				error instanceof ServerManagedElsewhereError ? error.owner : undefined,
		};
	} finally {
		executor?.close();
	}

	const failure = result.error ?? new AppError("BOOTSTRAP_FAILED");
	// Refused because another instance manages it: nothing changed, so the
	// status stays (a Ready server is not turned into Error).
	const refused = !result.success && !!result.foreignOwner;
	// Could not reach the server before bootstrap changed anything (SSH
	// down, timeout, changed host key): a Ready server stays Ready with the
	// error recorded, like a failed connection test; others are
	// Unreachable. A failure once bootstrap started changing the server
	// (packages, Docker, network, claim, Traefik), or any other refusal
	// (e.g. ports busy with no Traefik running), is a real bootstrap
	// failure: Error.
	const unreached =
		!result.success && !result.changed && isConnectionFailure(failure);
	await db
		.update(servers)
		.set(
			refused
				? {
						status: row.status,
						...lastErrorColumns(failure),
						updatedAt: new Date(),
					}
				: unreached
					? {
							status: row.status === "ready" ? "ready" : "unreachable",
							...lastErrorColumns(failure),
							updatedAt: new Date(),
						}
					: result.success
						? {
								status: "ready",
								os: result.os ?? row.os,
								dockerVersion: result.dockerVersion ?? row.dockerVersion,
								traefikVersion: traefikVersion(),
								...lastErrorColumns(null),
								updatedAt: new Date(),
							}
						: {
								status: "error",
								...lastErrorColumns(failure),
								updatedAt: new Date(),
							},
		)
		.where(eq(servers.id, row.id));

	if (result.success && row.isDefault) {
		// Installer --domain: route the panel once Traefik runs here.
		void import("#/features/settings/instance.server.ts")
			.then(({ applyPanelDomainFromEnv }) => applyPanelDomainFromEnv())
			.catch((error) =>
				console.error("[panel] could not apply the panel domain", error),
			);
	}

	return result.success
		? { success: true }
		: { success: false, error: failure };
}

/**
 * Build SSH credentials for a server. Keys are resolved from `ssh_keys` at
 * connection time so key rotations apply to every server using them.
 */
async function resolveSSHConnection(row: ServerRow): Promise<SSHConnection> {
	const base: SSHConnection = {
		host: row.host,
		port: row.port,
		username: row.username,
		hostKey: hostKeyPolicy(row),
	};
	if (row.authMethod === "private_key") {
		if (!row.sshKeyId) throw new AppError("SSH_KEY_NOT_FOUND");
		return {
			...base,
			...(await getSSHKeyCredentials(row, row.sshKeyId)),
		};
	}
	return {
		...base,
		password: row.passwordEncrypted
			? decrypt(row.passwordEncrypted)
			: undefined,
	};
}

/** TOFU: verify the stored host key, or store the first one seen. */
function hostKeyPolicy(row: ServerRow): HostKeyPolicy {
	return {
		expected: row.hostKeyFingerprint,
		onFirstSeen: async (fingerprint) => {
			const stored = await db
				.update(servers)
				.set({ hostKeyFingerprint: fingerprint })
				.where(and(eq(servers.id, row.id), isNull(servers.hostKeyFingerprint)))
				.returning({ id: servers.id });
			if (stored.length > 0) return;
			// Another connection stored a key first: this one must match it.
			const [current] = await db
				.select({ fingerprint: servers.hostKeyFingerprint })
				.from(servers)
				.where(eq(servers.id, row.id))
				.limit(1);
			if (current?.fingerprint && current.fingerprint !== fingerprint) {
				throw new HostKeyMismatchError(current.fingerprint, fingerprint);
			}
		},
	};
}

/** Forget the stored host key so the next connection trusts the new one. */
export async function resetHostKey(
	actor: Actor,
	serverId: string,
): Promise<ServerDTO> {
	if (isServerBusy(serverId)) throw new AppError("SERVER_BUSY");
	const [row] = await db
		.update(servers)
		.set({
			hostKeyFingerprint: null,
			...lastErrorColumns(null),
			updatedAt: new Date(),
		})
		.where(and(eq(servers.id, serverId), eq(servers.teamId, actor.teamId)))
		.returning(dtoColumns);
	if (!row) throw new AppError("SERVER_NOT_FOUND");
	audit({
		actor,
		action: "server.host_key.reset",
		targetType: "server",
		targetId: serverId,
	});
	return row;
}

/**
 * Replace password auth with a generated key. The key is stored first (so
 * we never install a key we don't hold), then installed and verified, and
 * only then the password is dropped. Runs under the per-server job lock.
 */
async function switchToManagedKey(
	actor: Actor,
	server: ServerRow,
	log: JobLogger,
): Promise<ServerRow> {
	log.event("server.managed_key_installing");
	const generated = await generateSSHKey(
		DEFAULT_SSH_KEY_TYPE,
		`${APP_ID}@${server.host}`,
	);
	const key = await createSSHKey(actor, {
		name: `${APP_ID}-managed (${server.name})`,
		description: `Generated for ${server.username}@${server.host}:${server.port}`,
		privateKey: generated.privateKey,
		publicKey: generated.publicKey,
	});

	try {
		const passwordConnection = await resolveSSHConnection(server);
		const passwordExecutor = new SshExecutor(passwordConnection);
		try {
			await installManagedKey(passwordExecutor, generated.publicKey);
		} finally {
			passwordExecutor.close();
		}

		const check = await testConnection({
			host: server.host,
			port: server.port,
			username: server.username,
			privateKey: generated.privateKey,
			// Same host key that the password connection just verified/stored.
			hostKey: { expected: passwordConnection.hostKey?.expected },
		});
		if (!check.success) {
			throw new AppError("SSH_MANAGED_KEY_LOGIN_FAILED", {
				reason: {
					$error: errorInfoOf(check.error ?? new AppError("JOB_FAILED")),
				},
			});
		}
	} catch (error) {
		await deleteSSHKey(actor, key.id).catch(() => {});
		throw error;
	}

	const [updated] = await db
		.update(servers)
		.set({
			authMethod: "private_key",
			sshKeyId: key.id,
			passwordEncrypted: null,
			updatedAt: new Date(),
		})
		.where(and(eq(servers.id, server.id), eq(servers.teamId, actor.teamId)))
		.returning();
	log.event("server.managed_key_installed");
	return updated;
}

/**
 * Test credentials from the server form before (or without) saving them.
 * Blank password in edit mode falls back to the stored one.
 */
export async function testServerCredentials(
	actor: Actor,
	data: TestServerCredentialsInput,
): Promise<{ success: boolean; error?: ErrorInfo }> {
	let stored: ServerRow | undefined;
	if (data.id) {
		[stored] = await db
			.select()
			.from(servers)
			.where(and(eq(servers.id, data.id), eq(servers.teamId, actor.teamId)))
			.limit(1);
		if (!stored) throw new AppError("SERVER_NOT_FOUND");
	}

	const host = data.host ?? stored?.host;
	const port = data.port ?? stored?.port;
	const username = data.username ?? stored?.username;
	if (!host || !port || !username) {
		return {
			success: false,
			error: errorInfoOf(new AppError("SERVER_CREDENTIALS_REQUIRED")),
		};
	}

	const authMethod = data.authMethod ?? stored?.authMethod;
	const connection: SSHConnection = { host, port, username };
	// Only verify the stored host key when the target didn't change.
	if (stored && host === stored.host && port === stored.port) {
		connection.hostKey = { expected: stored.hostKeyFingerprint };
	}
	if (authMethod === "private_key") {
		const keyId = data.sshKeyId ?? stored?.sshKeyId;
		if (!keyId) throw new AppError("SSH_KEY_NOT_FOUND");
		Object.assign(connection, await getSSHKeyCredentials(actor, keyId));
	} else if (data.password) {
		connection.password = data.password;
	} else if (stored?.passwordEncrypted) {
		connection.password = decrypt(stored.passwordEncrypted);
	}

	const result = await testConnection(connection);
	if (result.hostKeyMismatch) {
		throw new AppError("HOST_KEY_MISMATCH", result.hostKeyMismatch);
	}
	// Persist the outcome for the stored server when its address and
	// credentials are the ones tested (status model: never downgrades
	// ready/bootstrapping).
	if (
		stored &&
		host === stored.host &&
		port === stored.port &&
		username === stored.username &&
		!data.password &&
		authMethod === stored.authMethod &&
		(data.sshKeyId ?? stored.sshKeyId) === stored.sshKeyId &&
		stored.status !== "ready" &&
		stored.status !== "bootstrapping"
	) {
		await db
			.update(servers)
			.set(
				result.success
					? {
							status: "reachable",
							...lastErrorColumns(null),
							updatedAt: new Date(),
						}
					: {
							status: "unreachable",
							...lastErrorColumns(result.error ?? null),
							updatedAt: new Date(),
						},
			)
			.where(eq(servers.id, stored.id));
	}
	return {
		success: result.success,
		error: result.error ? errorInfoOf(result.error) : undefined,
	};
}

/** One job owned by the user; throws DEPLOYMENT_NOT_FOUND otherwise. */
export async function getDeployment(
	actor: Actor,
	deploymentId: string,
): Promise<DeploymentDTO> {
	await recoverOrphanedJobs();
	const row = await db
		.select(dtoDeploymentColumns)
		.from(deployments)
		.where(
			and(
				eq(deployments.id, deploymentId),
				eq(deployments.teamId, actor.teamId),
			),
		)
		.limit(1);
	if (!row[0]) {
		throw new AppError("DEPLOYMENT_NOT_FOUND");
	}
	return row[0];
}

/**
 * Resource policy of a server (M6). Existing apps keep running; the next
 * deploy applies the default limit or refuses services without one.
 */
export async function updateServerResourcePolicy(
	actor: Actor,
	input: ServerResourcePolicyInput,
): Promise<ServerDTO> {
	await getServerRow(actor, input.serverId, "server.manage");
	const [row] = await db
		.update(servers)
		.set({
			requireLimits: input.requireLimits,
			defaultMemoryMb: input.defaultMemoryMb,
			updatedAt: new Date(),
		})
		.where(eq(servers.id, input.serverId))
		.returning(dtoColumns);
	audit({
		actor,
		action: "server.update",
		targetType: "server",
		targetId: input.serverId,
		meta: {
			requireLimits: input.requireLimits,
			defaultMemoryMb: input.defaultMemoryMb,
		},
	});
	return row;
}
