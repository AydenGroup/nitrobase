import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { z } from "zod";
import { jobTitle } from "#/config/job-titles.ts";
import { getConfig } from "#/config/server.ts";
import { APP_ID } from "#/config/shared.ts";
import {
	REPOSITORY_PROBE_FILES_SHOWN,
	TEXT_LIMITS,
} from "#/config/text-limits.ts";
import { db } from "#/db/index.ts";
import { apps, domains } from "#/db/schema/apps.ts";
import {
	appGitSources,
	appReleases,
	gitCredentials,
	gitWebhookDeliveries,
} from "#/db/schema/git.ts";
import { servers } from "#/db/schema/server.ts";
import {
	runDeploy,
	setStatus,
	startAppJob,
} from "#/features/apps/app-jobs.server.ts";
import { getAppRow, getAppServer } from "#/features/apps/apps.server.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess } from "#/features/auth/access.ts";
import {
	type JobContext,
	type JobOutcome,
	startJob,
	withAppServerLock,
} from "#/features/deployments/deployments.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import { clip } from "#/libs/format.ts";
import { audit } from "#/server/services/audit.ts";
import { errorInfoOf, lastErrorColumns } from "#/server/services/error-info.ts";
import { emitEvent } from "#/server/services/events/bus.ts";
import { pickRollback } from "#/server/services/git/retention.ts";
import {
	newWebhookId,
	newWebhookSecret,
	webhookProviders,
} from "#/server/services/git/webhooks.ts";
import { assertServerOwned } from "#/server/services/server-setup.ts";
import { parseKeyPair } from "#/server/services/ssh-key-parse.ts";
import { generateSSHKey } from "#/server/services/ssh-keygen.ts";
import { decrypt, encrypt } from "#/utils/crypto.ts";
import { AppError } from "#/utils/error.ts";
import {
	buildCommit,
	checkedGitUrl,
	type GitSourceRow,
	getGitSourceRow,
	inspectOnServer,
	normalizeSubdir,
	readBuildSecrets,
} from "./build.server";
import {
	type BuildSecretsEditSchema,
	type BuildSettings,
	BuildSettingsSchema,
	type CreateCredentialInputSchema,
	type DeliveryView,
	GIT_APP_SERVICE,
	type GitAppSpec,
	type GitAppView,
	type GitCredentialView,
	type GitDefaults,
	type GitSource,
	type ReleaseView,
	type RepoInspection,
	type RuntimeSettings,
} from "./schema";

type CredentialRow = typeof gitCredentials.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ZodOut<S extends z.ZodType> = z.infer<S>;

/** Path of an app's push webhook (the panel origin is prepended). */
export function webhookPath(webhookId: string): string {
	return `/api/hooks/git/${webhookId}`;
}

export function gitDefaults(): GitDefaults {
	const config = getConfig();
	return {
		limits: {
			memoryMb: config.BUILD_MEMORY_MB,
			cpus: config.BUILD_CPUS,
			timeoutSeconds: config.BUILD_TIMEOUT_SECONDS,
		},
		maxTimeoutSeconds: config.BUILD_MAX_TIMEOUT_SECONDS,
		keepImages: config.GIT_KEEP_IMAGES,
	};
}

// ---------------------------------------------------------------------------
// Validation shared by create and update

function assertBuildLimits(build: BuildSettings, keepImages: number | null) {
	const config = getConfig();
	if (
		build.limits.timeoutSeconds !== null &&
		build.limits.timeoutSeconds > config.BUILD_MAX_TIMEOUT_SECONDS
	) {
		throw new AppError("GIT_BUILD_TIMEOUT_TOO_LONG", {
			max: config.BUILD_MAX_TIMEOUT_SECONDS,
		});
	}
	if (keepImages !== null && keepImages > config.GIT_KEEP_IMAGES_MAX) {
		throw new AppError("GIT_KEEP_IMAGES_TOO_MANY", {
			max: config.GIT_KEEP_IMAGES_MAX,
		});
	}
}

function assertRuntime(runtime: RuntimeSettings) {
	const seen = new Set<string>();
	for (const volume of runtime.volumes) {
		if (seen.has(volume.name)) {
			throw new AppError("GIT_VOLUME_DUPLICATE", { name: volume.name });
		}
		seen.add(volume.name);
	}
}

/**
 * Check a source: URL syntax + SSRF (resolved here, pinned at clone time),
 * protocol vs. authentication, and the credential (same team, of the
 * right kind, not used by another app).
 */
async function checkSource(
	actor: Actor,
	source: GitSource,
	appId: string | null,
): Promise<{ source: GitSource; credential: CredentialRow | null }> {
	const { url } = await checkedGitUrl(source);
	const normalized: GitSource = {
		...source,
		repoUrl: url.url,
		subdir: normalizeSubdir(source.subdir),
	};
	if (url.protocol === "ssh" && source.auth !== "deploy_key") {
		throw new AppError("GIT_SSH_NEEDS_KEY");
	}
	if (source.auth === "token" && url.protocol === "ssh") {
		throw new AppError("GIT_TOKEN_NEEDS_HTTPS");
	}
	if (source.auth === "none") {
		return { source: { ...normalized, credentialId: null }, credential: null };
	}
	if (!source.credentialId) throw new AppError("GIT_CREDENTIAL_REQUIRED");
	const [credential] = await db
		.select()
		.from(gitCredentials)
		.where(eq(gitCredentials.id, source.credentialId))
		.limit(1);
	if (
		!credential ||
		credential.teamId !== actor.teamId ||
		credential.kind !== source.auth ||
		(credential.appId !== null && credential.appId !== appId)
	) {
		throw new AppError("GIT_CREDENTIAL_INVALID");
	}
	return { source: normalized, credential };
}

export interface PreparedGitSource {
	spec: GitAppSpec;
	credentialId: string | null;
}

/** Validate a wizard spec before the app is created (no side effects). */
export async function prepareGitSource(
	actor: Actor,
	spec: GitAppSpec,
): Promise<PreparedGitSource> {
	assertBuildLimits(spec.build, spec.keepImages);
	assertRuntime(spec.runtime);
	const { source, credential } = await checkSource(actor, spec.source, null);
	return { spec: { ...spec, source }, credentialId: credential?.id ?? null };
}

/** Store the source of a new app (inside its creation transaction). */
export async function insertGitSource(
	tx: Tx,
	actor: Actor,
	appId: string,
	prepared: PreparedGitSource,
): Promise<void> {
	const { spec } = prepared;
	if (prepared.credentialId) {
		const attached = await tx
			.update(gitCredentials)
			.set({ appId })
			.where(
				and(
					eq(gitCredentials.id, prepared.credentialId),
					eq(gitCredentials.teamId, actor.teamId),
					isNull(gitCredentials.appId),
				),
			)
			.returning({ id: gitCredentials.id });
		if (attached.length !== 1) throw new AppError("GIT_CREDENTIAL_INVALID");
	}
	await tx.insert(appGitSources).values({
		appId,
		repoUrl: spec.source.repoUrl,
		branch: spec.source.branch,
		subdir: spec.source.subdir,
		submodules: spec.source.submodules,
		auth: spec.source.auth,
		credentialId: prepared.credentialId,
		allowPrivateHost: spec.source.allowPrivateHost,
		build: spec.build,
		runtime: spec.runtime,
		buildSecretsEncrypted: Object.keys(spec.buildSecrets).length
			? encrypt(JSON.stringify(spec.buildSecrets))
			: null,
		keepImages: spec.keepImages,
		webhookId: newWebhookId(randomBytes),
		webhookSecretEncrypted: encrypt(newWebhookSecret(randomBytes)),
		webhookEnabled: spec.webhook,
	});
}

// ---------------------------------------------------------------------------
// Credentials (deploy keys, tokens)

function credentialView(row: CredentialRow): GitCredentialView {
	return {
		id: row.id,
		kind: row.kind,
		publicKey: row.publicKey,
		fingerprint: row.fingerprint,
		username: row.username,
		createdAt: row.createdAt,
	};
}

/** Wizard credentials never attached to an app expire. */
async function prunePendingCredentials(teamId: string): Promise<void> {
	const cutoff = new Date(
		Date.now() - getConfig().GIT_PENDING_KEY_TTL_HOURS * 3_600_000,
	);
	await db
		.delete(gitCredentials)
		.where(
			and(
				eq(gitCredentials.teamId, teamId),
				isNull(gitCredentials.appId),
				lt(gitCredentials.createdAt, cutoff),
			),
		);
}

/**
 * New deploy key (ed25519, generated here; only the public key leaves the
 * server) or HTTPS token. Without `appId` it waits for the wizard's app;
 * with one it is attached when the source is saved.
 */
export async function createGitCredential(
	actor: Actor,
	input: ZodOut<typeof CreateCredentialInputSchema>,
): Promise<GitCredentialView> {
	if (input.appId) {
		const app = await getAppRow(actor, input.appId, "app.source.manage");
		await getGitSourceRow(app.id);
	}
	await prunePendingCredentials(actor.teamId);
	let values: typeof gitCredentials.$inferInsert;
	if (input.kind === "deploy_key") {
		const key = await generateSSHKey("ed25519", `${APP_ID}-deploy-key`);
		const parsed = parseKeyPair({ privateKey: key.privateKey });
		values = {
			teamId: actor.teamId,
			userId: actor.userId,
			kind: "deploy_key",
			publicKey: key.publicKey,
			fingerprint: parsed.fingerprint,
			secretEncrypted: encrypt(key.privateKey),
		};
	} else {
		values = {
			teamId: actor.teamId,
			userId: actor.userId,
			kind: "token",
			username: input.username,
			secretEncrypted: encrypt(input.token),
		};
	}
	const [row] = await db.insert(gitCredentials).values(values).returning();
	audit({
		actor,
		action: "app.git_credential.create",
		targetType: input.appId ? "app" : undefined,
		targetId: input.appId,
		meta: { kind: input.kind, fingerprint: row.fingerprint ?? undefined },
	});
	return credentialView(row);
}

// ---------------------------------------------------------------------------
// Wizard: check a repository from a server

export async function inspectRepository(
	actor: Actor,
	input: { serverId: string; source: GitSource; build?: BuildSettings },
): Promise<RepoInspection> {
	const [server] = await db
		.select()
		.from(servers)
		.where(eq(servers.id, input.serverId))
		.limit(1);
	assertCanAccess(actor, server, "app.deploy", "SERVER_NOT_FOUND");
	if (server.status !== "ready") throw new AppError("SERVER_NOT_READY");
	const { source, credential } = await checkSource(actor, input.source, null);
	const executor = await getExecutor(server);
	try {
		await assertServerOwned(executor, await requireInstanceId());
		const { checkout, detection } = await inspectOnServer({
			executor,
			source,
			credential,
			build: input.build ?? BuildSettingsSchema.parse({}),
		});
		return {
			commitSha: checkout.clone.commitSha,
			message: checkout.clone.message,
			author: checkout.clone.author,
			committedAt: checkout.clone.committedAt,
			detection,
			files: checkout.probe.files.slice(0, REPOSITORY_PROBE_FILES_SHOWN),
			defaults: gitDefaults(),
		};
	} finally {
		executor.close();
	}
}

// ---------------------------------------------------------------------------
// App page

async function gitApp(
	actor: Actor,
	appId: string,
	permission: "app.view" | "app.source.manage" | "app.deploy" = "app.view",
): Promise<{ app: AppRow; row: GitSourceRow }> {
	const app = await getAppRow(actor, appId, permission);
	return { app, row: await getGitSourceRow(app.id) };
}

export async function getGitApp(
	actor: Actor,
	appId: string,
): Promise<GitAppView> {
	const { row } = await gitApp(actor, appId);
	const config = getConfig();
	const [credential] = row.credentialId
		? await db
				.select()
				.from(gitCredentials)
				.where(eq(gitCredentials.id, row.credentialId))
				.limit(1)
		: [];
	let host = "";
	try {
		host = new URL(row.repoUrl).hostname;
	} catch {}
	return {
		source: {
			repoUrl: row.repoUrl,
			branch: row.branch,
			subdir: row.subdir,
			submodules: row.submodules,
			auth: row.auth,
			credentialId: row.credentialId,
			allowPrivateHost: row.allowPrivateHost,
			host,
		},
		build: BuildSettingsSchema.parse(row.build),
		runtime: row.runtime,
		keepImages: row.keepImages ?? config.GIT_KEEP_IMAGES,
		buildSecretNames: Object.keys(readBuildSecrets(row)).sort(),
		credential: credential ? credentialView(credential) : null,
		detectedBuilder:
			(row.detectedBuilder as GitAppView["detectedBuilder"]) ?? null,
		webhook: {
			enabled: row.webhookEnabled,
			path: webhookPath(row.webhookId),
			providers: webhookProviders.map((provider) => provider.label),
		},
		defaults: gitDefaults(),
	};
}

export async function updateGitSource(
	actor: Actor,
	input: { appId: string; source: GitSource },
): Promise<void> {
	const { app, row } = await gitApp(actor, input.appId, "app.source.manage");
	const { source, credential } = await checkSource(actor, input.source, app.id);
	await withAppServerLock(app, async () => {
		await db.transaction(async (tx) => {
			if (credential && credential.appId === null) {
				await tx
					.update(gitCredentials)
					.set({ appId: app.id })
					.where(
						and(
							eq(gitCredentials.id, credential.id),
							isNull(gitCredentials.appId),
						),
					);
			}
			await tx
				.update(appGitSources)
				.set({
					repoUrl: source.repoUrl,
					branch: source.branch,
					subdir: source.subdir,
					submodules: source.submodules,
					auth: source.auth,
					credentialId: credential?.id ?? null,
					allowPrivateHost: source.allowPrivateHost,
					updatedAt: new Date(),
				})
				.where(eq(appGitSources.appId, app.id));
			// The previous credential is not used any more.
			if (row.credentialId && row.credentialId !== credential?.id) {
				await tx
					.delete(gitCredentials)
					.where(eq(gitCredentials.id, row.credentialId));
			}
		});
	});
	audit({
		actor,
		action: "app.source.update",
		targetType: "app",
		targetId: app.id,
		meta: {
			repository: source.repoUrl,
			branch: source.branch,
			subdir: source.subdir,
			auth: source.auth,
		},
	});
}

/**
 * Build and runtime settings. A changed port updates the app's routes and
 * flags a redeploy (the running container still has the old settings).
 */
export async function updateBuildSettings(
	actor: Actor,
	input: {
		appId: string;
		build: BuildSettings;
		runtime: RuntimeSettings;
		keepImages: number | null;
	},
): Promise<void> {
	const { app, row } = await gitApp(actor, input.appId, "app.source.manage");
	assertBuildLimits(input.build, input.keepImages);
	assertRuntime(input.runtime);
	const runtimeChanged =
		JSON.stringify(row.runtime) !== JSON.stringify(input.runtime);
	await withAppServerLock(app, async () => {
		await db
			.update(appGitSources)
			.set({
				build: input.build,
				runtime: input.runtime,
				keepImages: input.keepImages,
				updatedAt: new Date(),
			})
			.where(eq(appGitSources.appId, app.id));
		if (row.runtime.port !== input.runtime.port) {
			await db
				.update(domains)
				.set({ port: input.runtime.port })
				.where(
					and(eq(domains.appId, app.id), eq(domains.service, GIT_APP_SERVICE)),
				);
		}
		if (runtimeChanged && app.commitSha) {
			await setStatus(app.id, { needsRedeploy: true });
		}
	});
	audit({
		actor,
		action: "app.build_settings.update",
		targetType: "app",
		targetId: app.id,
		meta: {
			builder: input.build.builder,
			port: input.runtime.port,
			volumes: input.runtime.volumes.map((volume) => volume.name),
			keepImages: input.keepImages,
		},
	});
}

export async function editBuildSecrets(
	actor: Actor,
	input: ZodOut<typeof BuildSecretsEditSchema>,
): Promise<string[]> {
	const { app } = await gitApp(actor, input.appId, "app.source.manage");
	return withAppServerLock(app, async () => {
		const row = await getGitSourceRow(app.id);
		const secrets = readBuildSecrets(row);
		for (const name of input.remove) delete secrets[name];
		Object.assign(secrets, input.set);
		await db
			.update(appGitSources)
			.set({
				buildSecretsEncrypted: Object.keys(secrets).length
					? encrypt(JSON.stringify(secrets))
					: null,
				updatedAt: new Date(),
			})
			.where(eq(appGitSources.appId, app.id));
		audit({
			actor,
			action: "app.build_secrets.update",
			targetType: "app",
			targetId: app.id,
			meta: { set: Object.keys(input.set), removed: input.remove },
		});
		return Object.keys(secrets).sort();
	});
}

export async function setWebhookEnabled(
	actor: Actor,
	input: { appId: string; enabled: boolean },
): Promise<void> {
	const { app } = await gitApp(actor, input.appId, "app.source.manage");
	await db
		.update(appGitSources)
		.set({ webhookEnabled: input.enabled, updatedAt: new Date() })
		.where(eq(appGitSources.appId, app.id));
	audit({
		actor,
		action: "app.webhook.update",
		targetType: "app",
		targetId: app.id,
		meta: { enabled: input.enabled },
	});
}

/** The webhook secret (audited reveal). */
export async function revealWebhookSecret(
	actor: Actor,
	appId: string,
): Promise<string> {
	const { app, row } = await gitApp(actor, appId, "app.source.manage");
	audit({
		actor,
		action: "app.webhook.reveal",
		targetType: "app",
		targetId: app.id,
	});
	return decrypt(row.webhookSecretEncrypted);
}

/** New secret and new URL id (the old URL stops answering). */
export async function rotateWebhookSecret(
	actor: Actor,
	appId: string,
): Promise<string> {
	const { app } = await gitApp(actor, appId, "app.source.manage");
	const webhookId = newWebhookId(randomBytes);
	await db
		.update(appGitSources)
		.set({
			webhookId,
			webhookSecretEncrypted: encrypt(newWebhookSecret(randomBytes)),
			updatedAt: new Date(),
		})
		.where(eq(appGitSources.appId, app.id));
	audit({
		actor,
		action: "app.webhook.rotate",
		targetType: "app",
		targetId: app.id,
	});
	return webhookPath(webhookId);
}

export async function listDeliveries(
	actor: Actor,
	appId: string,
): Promise<DeliveryView[]> {
	const { app } = await gitApp(actor, appId);
	return db
		.select({
			id: gitWebhookDeliveries.id,
			provider: gitWebhookDeliveries.provider,
			event: gitWebhookDeliveries.event,
			branch: gitWebhookDeliveries.branch,
			commitSha: gitWebhookDeliveries.commitSha,
			status: gitWebhookDeliveries.status,
			reason: gitWebhookDeliveries.reason,
			deploymentId: gitWebhookDeliveries.deploymentId,
			createdAt: gitWebhookDeliveries.createdAt,
		})
		.from(gitWebhookDeliveries)
		.where(eq(gitWebhookDeliveries.appId, app.id))
		.orderBy(desc(gitWebhookDeliveries.createdAt))
		.limit(30);
}

export async function listReleases(
	actor: Actor,
	appId: string,
): Promise<ReleaseView[]> {
	const { app } = await gitApp(actor, appId);
	const rows = await db
		.select()
		.from(appReleases)
		.where(eq(appReleases.appId, app.id))
		.orderBy(desc(appReleases.createdAt))
		.limit(50);
	return rows.map((row) => {
		const live = row.commitSha === app.commitSha;
		return {
			id: row.id,
			commitSha: row.commitSha,
			message: row.message,
			author: row.author,
			committedAt: row.committedAt,
			builder: row.builder,
			status: row.status,
			imageTag: row.imageTag,
			live,
			buildDeploymentId: row.buildDeploymentId,
			buildDurationMs: row.buildDurationMs,
			lastDeployedAt: row.lastDeployedAt,
			createdAt: row.createdAt,
			rollbackable: !live && row.status === "ready",
		};
	});
}

// ---------------------------------------------------------------------------
// Jobs

export type BuildTrigger = "manual" | "webhook" | "create";

/** Commit metadata of the release a job deployed (for events). */
async function releaseOf(appId: string, commitSha: string | null) {
	if (!commitSha) return null;
	const [row] = await db
		.select()
		.from(appReleases)
		.where(
			and(eq(appReleases.appId, appId), eq(appReleases.commitSha, commitSha)),
		)
		.limit(1);
	return row ?? null;
}

function emitBuildEvent(
	app: AppRow,
	branch: string,
	commitSha: string | null,
	outcome: JobOutcome,
	message: string,
	deploymentId: string,
): void {
	emitEvent({
		id: outcome.success ? "build.succeeded" : "build.failed",
		teamId: app.teamId,
		subject: `${app.id}:${commitSha ?? deploymentId}`,
		serverId: app.serverId,
		appId: app.id,
		params: {
			commit: commitSha ? commitSha.slice(0, 12) : "?",
			branch,
			message: clip(message, TEXT_LIMITS.shortText),
			error: outcome.error ? { $error: errorInfoOf(outcome.error) } : "",
			job: deploymentId,
		},
	});
}

/**
 * Build (unless the image exists) and deploy: the branch tip, or
 * `commitSha`. One job (`app_build`) on the app's server.
 */
export async function runBuildAndDeploy(
	appId: string,
	ctx: JobContext,
	options: { commitSha?: string; buildOnlyIfStopped?: boolean },
): Promise<JobOutcome> {
	const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	if (!app) return { success: false, error: new AppError("APP_NOT_FOUND") };
	const source = await getGitSourceRow(app.id);
	let commitSha: string | null = options.commitSha ?? null;
	let outcome: JobOutcome;
	const executor = await getExecutor(await getAppServer(app));
	try {
		await assertServerOwned(executor, await requireInstanceId());
		const built = await buildCommit({
			executor,
			app,
			commitSha: options.commitSha,
			ctx,
		});
		commitSha = built.commitSha;
		outcome = { success: true };
	} catch (error) {
		ctx.event("job.error", { error: { $error: errorInfoOf(error) } });
		await setStatus(app.id, {
			// Never deployed: the app shows the failure; a running app keeps running.
			...(app.commitSha ? {} : { status: "error" as const }),
			...lastErrorColumns(error),
		});
		outcome = { success: false, error };
	} finally {
		executor.close();
	}
	if (outcome.success && commitSha) {
		const [current] = await db
			.select({ status: apps.status })
			.from(apps)
			.where(eq(apps.id, app.id))
			.limit(1);
		if (options.buildOnlyIfStopped && current?.status === "stopped") {
			// A push must not start an app its owner stopped.
			ctx.event("build.stopped_app", { commit: commitSha.slice(0, 12) });
			return outcome;
		}
		ctx.event("build.deploying", { commit: commitSha.slice(0, 12) });
		// The build ran under the app's lock only; the deploy takes the
		// server lock like every other deploy.
		const deploy = () =>
			runDeploy(app.id, "redeploy", undefined, ctx, {
				source: { commitSha: commitSha as string, allowBuild: true },
			});
		try {
			outcome = ctx.withServerLock
				? await ctx.withServerLock(deploy)
				: await deploy();
		} catch (error) {
			outcome = { success: false, error };
		}
	}
	const release = await releaseOf(app.id, commitSha);
	emitBuildEvent(
		app,
		source.branch,
		commitSha,
		outcome,
		release?.message ?? "",
		ctx.deploymentId,
	);
	return outcome;
}

export async function startBuildAndDeploy(
	actor: Actor,
	app: AppRow,
	options: { commitSha?: string; trigger: BuildTrigger },
): Promise<{ deploymentId: string }> {
	await getGitSourceRow(app.id);
	if (options.trigger !== "create") {
		audit({
			actor,
			action: "app.build",
			targetType: "app",
			targetId: app.id,
			meta: {
				trigger: options.trigger,
				commit: options.commitSha ?? "branch tip",
			},
		});
	}
	// Clone and build hold only the app's lock: other apps on the server
	// keep deploying, backing up and routing meanwhile.
	return startJob(
		{
			actor,
			serverId: app.serverId,
			appId: app.id,
			type: "app_build",
			title: jobTitle("app_build", { app: app.name }),
			lock: "app",
		},
		(ctx) =>
			runBuildAndDeploy(app.id, ctx, {
				commitSha: options.commitSha,
				buildOnlyIfStopped: options.trigger === "webhook",
			}),
	);
}

/** "Deploy latest commit" / "Deploy this commit" (app.deploy). */
export async function deployCommit(
	actor: Actor,
	input: { appId: string; commitSha?: string },
): Promise<{ deploymentId: string }> {
	const app = await getAppRow(actor, input.appId, "app.deploy");
	return startBuildAndDeploy(actor, app, {
		commitSha: input.commitSha,
		trigger: "manual",
	});
}

/** Redeploy a kept image (no build). */
export async function rollbackToRelease(
	actor: Actor,
	input: { appId: string; releaseId: string },
): Promise<{ deploymentId: string }> {
	const app = await getAppRow(actor, input.appId, "app.deploy");
	await getGitSourceRow(app.id);
	const releases = await db
		.select()
		.from(appReleases)
		.where(eq(appReleases.appId, app.id));
	const picked = pickRollback(releases, input.releaseId, app.commitSha);
	if ("refusal" in picked) {
		throw new AppError(
			picked.refusal === "not_found"
				? "GIT_RELEASE_NOT_FOUND"
				: picked.refusal === "live"
					? "GIT_ROLLBACK_LIVE"
					: "GIT_ROLLBACK_UNAVAILABLE",
		);
	}
	const { release } = picked;
	audit({
		actor,
		action: "app.rollback",
		targetType: "app",
		targetId: app.id,
		meta: { commit: release.commitSha, from: app.commitSha },
	});
	return startAppJob(
		app,
		actor,
		"app_rollback",
		jobTitle("app_rollback", {
			app: app.name,
			commit: release.commitSha.slice(0, 12),
		}),
		(ctx) =>
			runDeploy(app.id, "redeploy", undefined, ctx, {
				source: {
					commitSha: release.commitSha,
					allowBuild: false,
					trigger: "rollback",
				},
			}),
	);
}

/** Webhook deliveries kept per app. */
export async function pruneDeliveries(appId: string): Promise<void> {
	const keep = getConfig().WEBHOOK_DELIVERIES_KEPT;
	await db.execute(sql`
		delete from ${gitWebhookDeliveries}
		where ${gitWebhookDeliveries.appId} = ${appId}
		and ${gitWebhookDeliveries.id} not in (
			select ${gitWebhookDeliveries.id} from ${gitWebhookDeliveries}
			where ${gitWebhookDeliveries.appId} = ${appId}
			order by ${gitWebhookDeliveries.createdAt} desc
			limit ${keep}
		)
	`);
}
