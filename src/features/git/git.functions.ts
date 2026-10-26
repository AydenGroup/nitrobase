import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import {
	createGitCredential,
	deployCommit,
	editBuildSecrets,
	getGitApp,
	inspectRepository,
	listDeliveries,
	listReleases,
	revealWebhookSecret,
	rollbackToRelease,
	rotateWebhookSecret,
	setWebhookEnabled,
	updateBuildSettings,
	updateGitSource,
} from "./git.server";
import {
	BuildSecretsEditSchema,
	BuildSettingsSchema,
	CreateCredentialInputSchema,
	DeployCommitInputSchema,
	InspectRepoInputSchema,
	RollbackInputSchema,
	UpdateBuildInputSchema,
	UpdateGitSourceInputSchema,
	WebhookSettingsInputSchema,
} from "./schema";

/** Git apps (R2 M1): repository, build, releases and push webhooks. */

export const getGitAppFn = createServerFn({ method: "GET" })
	.validator((appId: string) => z.guid().parse(appId))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) => getGitApp(context.actor, data));

export const listReleasesFn = createServerFn({ method: "GET" })
	.validator((appId: string) => z.guid().parse(appId))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) => listReleases(context.actor, data));

export const listDeliveriesFn = createServerFn({ method: "GET" })
	.validator((appId: string) => z.guid().parse(appId))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) => listDeliveries(context.actor, data));

/** Wizard: clone the branch on the chosen server and detect the builder. */
export const inspectRepoFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		InspectRepoInputSchema.extend({
			build: BuildSettingsSchema.optional(),
		}).parse(data),
	)
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) => inspectRepository(context.actor, data));

/**
 * New deploy key or token: for the wizard (no app yet; needs app.deploy)
 * or for an existing app's Source settings (checked: app.source.manage).
 */
export const createGitCredentialFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CreateCredentialInputSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) =>
		createGitCredential(context.actor, data),
	);

export const updateGitSourceFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => UpdateGitSourceInputSchema.parse(data))
	.middleware([requirePermission("app.source.manage")])
	.handler(async ({ context, data }) => {
		await updateGitSource(context.actor, data);
		return { ok: true as const };
	});

export const updateBuildSettingsFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => UpdateBuildInputSchema.parse(data))
	.middleware([requirePermission("app.source.manage")])
	.handler(async ({ context, data }) => {
		await updateBuildSettings(context.actor, data);
		return { ok: true as const };
	});

export const editBuildSecretsFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => BuildSecretsEditSchema.parse(data))
	.middleware([requirePermission("app.source.manage")])
	.handler(async ({ context, data }) => ({
		names: await editBuildSecrets(context.actor, data),
	}));

export const setWebhookEnabledFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => WebhookSettingsInputSchema.parse(data))
	.middleware([requirePermission("app.source.manage")])
	.handler(async ({ context, data }) => {
		await setWebhookEnabled(context.actor, data);
		return { ok: true as const };
	});

/** POST: the reveal is audited. */
export const revealWebhookSecretFn = createServerFn({ method: "POST" })
	.validator((appId: string) => z.guid().parse(appId))
	.middleware([requirePermission("app.source.manage")])
	.handler(async ({ context, data }) => ({
		secret: await revealWebhookSecret(context.actor, data),
	}));

export const rotateWebhookSecretFn = createServerFn({ method: "POST" })
	.validator((appId: string) => z.guid().parse(appId))
	.middleware([requirePermission("app.source.manage")])
	.handler(async ({ context, data }) => ({
		path: await rotateWebhookSecret(context.actor, data),
	}));

/** Build and deploy the branch tip (or one commit). */
export const deployCommitFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => DeployCommitInputSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) => deployCommit(context.actor, data));

/** Redeploy a kept image without rebuilding. */
export const rollbackFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => RollbackInputSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) => rollbackToRelease(context.actor, data));
