import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n.ts";
import {
	createAndDeployApp,
	deleteApp,
	previewAppUpdate,
	rerunRotateHook,
	rotateAppVariable,
	startAppAction,
	updateServiceEnv,
} from "./app-jobs.server";
import {
	deployDefaults,
	getAppEnv,
	getAppOverview,
	listAppDeployments,
	listApps,
	listServiceEnv,
	revealAppEnv,
	revealCredential,
	setPublishedPorts,
	updateAppEnv,
} from "./apps.server";
import {
	analyzeCustomCompose,
	previewCustomCompose,
	revealCustomCompose,
	updateCustomCompose,
} from "./custom-compose.server";
import {
	addDomain,
	checkDomains,
	listAllDomains,
	removeDomain,
	setPrimaryDomain,
} from "./domains.server";
import { startMoveApp } from "./move.server";
import { runPreflight } from "./preflight.server";
import {
	AddDomainSchema,
	AnalyzeComposeSchema,
	AppActionSchema,
	AppIdSchema,
	CreateAppSchema,
	CustomComposePreviewSchema,
	CustomComposeUpdateSchema,
	DeleteAppSchema,
	DomainIdSchema,
	MoveAppSchema,
	PreflightInputSchema,
	PreviewAppUpdateSchema,
	RerunRotateHookSchema,
	RevealCredentialSchema,
	RotateVariableSchema,
	ServiceEnvQuerySchema,
	SetPublishedPortsSchema,
	UpdateAppEnvSchema,
	UpdateServiceEnvSchema,
} from "./schema";

/** Instance defaults the deploy forms show (free domain provider). */
export const getDeployDefaultsFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("app.view")])
	.handler(async () => deployDefaults());

export const listAppsFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("app.view")])
	.handler(async ({ context }) => listApps(context.actor));

export const getAppFn = createServerFn({ method: "GET" })
	.validator((appId: string) => AppIdSchema.parse(appId))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) => getAppOverview(context.actor, data));

export const listAppDeploymentsFn = createServerFn({ method: "GET" })
	.validator((appId: string) => AppIdSchema.parse(appId))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		listAppDeployments(context.actor, data),
	);

export const createAppFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("app.deploy")])
	.handler(async ({ context, data }) =>
		createAndDeployApp(
			context.actor,
			CreateAppSchema(context.i18n).parse(data),
		),
	);

export const appActionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => AppActionSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) => startAppAction(context.actor, data));

export const previewAppUpdateFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => PreviewAppUpdateSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) =>
		previewAppUpdate(context.actor, data.appId, data.version),
	);

export const deleteAppFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => DeleteAppSchema.parse(data))
	.middleware([requirePermission("app.delete")])
	.handler(async ({ context, data }) => deleteApp(context.actor, data));

export const getAppEnvFn = createServerFn({ method: "GET" })
	.validator((appId: string) => AppIdSchema.parse(appId))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) => getAppEnv(context.actor, data));

/** POST: reveals secrets (audited). */
export const revealAppEnvFn = createServerFn({ method: "POST" })
	.validator((appId: string) => AppIdSchema.parse(appId))
	.middleware([requirePermission("app.env.reveal")])
	.handler(async ({ context, data }) => revealAppEnv(context.actor, data));

export const updateAppEnvFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => UpdateAppEnvSchema.parse(data))
	.middleware([requirePermission("app.env.edit")])
	.handler(async ({ context, data }) =>
		updateAppEnv(context.actor, data.appId, {
			set: data.set,
			remove: data.remove,
			reset: data.reset,
			version: data.version,
		}),
	);

export const revealCredentialFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => RevealCredentialSchema.parse(data))
	.middleware([requirePermission("app.env.reveal")])
	.handler(async ({ context, data }) =>
		revealCredential(context.actor, data.appId, data.name),
	);

export const addDomainFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("domain.manage")])
	.handler(async ({ context, data }) =>
		addDomain(context.actor, AddDomainSchema(context.i18n).parse(data)),
	);

export const removeDomainFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => DomainIdSchema.parse(data))
	.middleware([requirePermission("domain.manage")])
	.handler(async ({ context, data }) =>
		removeDomain(context.actor, data.appId, data.domainId),
	);

export const setPrimaryDomainFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => DomainIdSchema.parse(data))
	.middleware([requirePermission("domain.manage")])
	.handler(async ({ context, data }) => {
		await setPrimaryDomain(context.actor, data.appId, data.domainId);
		return { success: true };
	});

export const checkDomainsFn = createServerFn({ method: "POST" })
	.validator((appId: string) => z.guid().parse(appId))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) => checkDomains(context.actor, data));

export const listAllDomainsFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("app.view")])
	.handler(async ({ context }) => listAllDomains(context.actor));

export const preflightFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => PreflightInputSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) =>
		runPreflight(context.actor, {
			...data,
			domain: data.domain || undefined,
		}),
	);

/** Regenerate a rotatable variable (+ dependents) and redeploy. Audited. */
export const rotateVariableFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => RotateVariableSchema.parse(data))
	.middleware([requirePermission("app.env.edit")])
	.handler(async ({ context, data }) =>
		rotateAppVariable(context.actor, data.appId, data.name, {
			backupFirst: data.backupFirst,
			runRotateHook: data.runRotateHook,
		}),
	);

/** Run a failed template `on_rotate` step again (job). Audited by the step. */
export const rerunRotateHookFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => RerunRotateHookSchema.parse(data))
	.middleware([requirePermission("app.env.edit")])
	.handler(async ({ context, data }) =>
		rerunRotateHook(context.actor, data.appId, data.name),
	);

export const setPublishedPortsFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => SetPublishedPortsSchema.parse(data))
	.middleware([requirePermission("app.env.edit")])
	.handler(async ({ context, data }) => {
		await setPublishedPorts(
			context.actor,
			data.appId,
			data.ports,
			data.loopback,
		);
		return { success: true };
	});

/** Names of a service's secret env (values are never returned). */
export const getServiceEnvFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => ServiceEnvQuerySchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ context, data }) =>
		listServiceEnv(context.actor, data.appId, data.service),
	);

export const updateServiceEnvFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => UpdateServiceEnvSchema.parse(data))
	.middleware([requirePermission("app.env.edit")])
	.handler(async ({ context, data }) => updateServiceEnv(context.actor, data));

/** What a pasted compose offers (services, ports, volumes) + policy verdict. */
export const analyzeComposeFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => AnalyzeComposeSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ data }) =>
		analyzeCustomCompose(data.templateId, data.compose, data.env),
	);

/** POST: the stored custom compose incl. its env (audited reveal). */
export const revealCustomComposeFn = createServerFn({ method: "POST" })
	.validator((appId: string) => AppIdSchema.parse(appId))
	.middleware([requirePermission("app.env.reveal")])
	.handler(async ({ context, data }) =>
		revealCustomCompose(context.actor, data),
	);

export const previewCustomComposeFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CustomComposePreviewSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) =>
		previewCustomCompose(context.actor, data.appId, data.spec),
	);

export const updateCustomComposeFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => CustomComposeUpdateSchema.parse(data))
	.middleware([requirePermission("app.deploy")])
	.handler(async ({ context, data }) =>
		updateCustomCompose(context.actor, data.appId, data.spec, {
			redeploy: data.redeploy,
		}),
	);

/**
 * Move the app to another Ready server of the team (backup → restore on the
 * target → health check → switch → remove the source copy; rolled back on
 * failure).
 */
export const moveAppFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => MoveAppSchema.parse(data))
	.middleware([requirePermission("app.move")])
	.handler(async ({ context, data }) => startMoveApp(context.actor, data));
