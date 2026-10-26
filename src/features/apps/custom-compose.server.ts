import { and, eq } from "drizzle-orm";
import { jobTitle } from "#/config/job-titles.ts";
import { isUniqueViolation } from "#/db/errors.ts";
import { db } from "#/db/index.ts";
import { apps, domains } from "#/db/schema/apps.ts";
import type { Actor } from "#/features/auth/access.ts";
import { withAppServerLock } from "#/features/deployments/deployments.server.ts";
import type { CustomComposeSpec } from "#/features/templates/schema.ts";
import {
	analyzeCustomComposeText,
	assertCustomSpec,
	isInlineTemplate,
} from "#/features/templates/templates.server.ts";
import {
	diffEnvKeys,
	diffLines,
	formatUnifiedDiff,
} from "#/server/services/apps/diff.ts";
import { audit } from "#/server/services/audit.ts";
import type { CustomComposeAnalysis } from "#/server/services/templates/custom-compose.ts";
import { assertHostname } from "#/server/services/templates/naming.ts";
import { AppError } from "#/utils/error.ts";
import { renderApp, runDeploy, startAppJob } from "./app-jobs.server";
import {
	deployedEnvValues,
	encryptCustomSpec,
	getAppRow,
	listAppDomains,
	readCustomSpec,
	reservedHosts,
} from "./apps.server";
import type { AppRow, AppUpdatePreview } from "./schema";

/**
 * Custom compose apps: the owner's compose file, env, routed service/port
 * and backup volumes, stored encrypted with the app. Every change goes
 * through `assertCustomSpec` (the same transform + policy as a template)
 * and takes effect on the next deploy.
 */

export async function analyzeCustomCompose(
	templateId: string,
	compose: string,
	env: string,
): Promise<CustomComposeAnalysis> {
	if (!(await isInlineTemplate(templateId))) {
		throw new AppError("TEMPLATE_NOT_INLINE");
	}
	return analyzeCustomComposeText(compose, env, templateId);
}

async function customApp(actor: Actor, appId: string): Promise<AppRow> {
	const app = await getAppRow(actor, appId);
	if (!(await isInlineTemplate(app.templateId)) || !app.customSpecEncrypted) {
		throw new AppError("APP_NOT_FOUND");
	}
	return app;
}

/** The stored spec, env included (audited: the env may hold secrets). */
export async function revealCustomCompose(
	actor: Actor,
	appId: string,
): Promise<CustomComposeSpec> {
	const app = await customApp(actor, appId);
	audit({
		actor,
		action: "app.compose.reveal",
		targetType: "app",
		targetId: app.id,
	});
	return readCustomSpec(app) as CustomComposeSpec;
}

/** Diff of the deployed compose against `spec`, nothing stored. */
export async function previewCustomCompose(
	actor: Actor,
	appId: string,
	spec: CustomComposeSpec,
): Promise<AppUpdatePreview & { analysis: CustomComposeAnalysis }> {
	const app = await customApp(actor, appId);
	const analysis = assertCustomSpec(spec, app.templateId);
	const rendered = await renderApp(
		{ ...app, customSpecEncrypted: encryptCustomSpec(spec) },
		"redeploy",
	);
	const composeLines = diffLines(app.composeDeployed ?? "", rendered.compose);
	return {
		version: rendered.version,
		commitSha: rendered.commitSha,
		composeDiff: formatUnifiedDiff(composeLines),
		composeChanged: composeLines.some((line) => line.kind !== "same"),
		env: diffEnvKeys(deployedEnvValues(app), rendered.values),
		warnings: rendered.warnings,
		analysis,
	};
}

/**
 * Store a new spec and align the app's domains with its routes: the
 * primary domain follows the first route; other domains whose service and
 * port are no longer routed are removed; new routes get
 * `<service>.<primary domain>`. With `redeploy`, a deploy job applies it.
 */
export async function updateCustomCompose(
	actor: Actor,
	appId: string,
	spec: CustomComposeSpec,
	options: { redeploy: boolean },
): Promise<{ deploymentId: string | null }> {
	const owned = await customApp(actor, appId);
	assertCustomSpec(spec, owned.templateId);
	await withAppServerLock(owned, async () => {
		const app = await customApp(actor, appId);
		const rows = await listAppDomains(app.id);
		const primary = rows.find((row) => row.primary);
		const routed = new Set(spec.routes.map((r) => `${r.service}:${r.port}`));
		const reserved = await reservedHosts();
		try {
			await db.transaction(async (tx) => {
				for (const row of rows) {
					if (row.primary) {
						await tx
							.update(domains)
							.set({
								service: spec.routes[0].service,
								port: spec.routes[0].port,
							})
							.where(eq(domains.id, row.id));
					} else if (!routed.has(`${row.service}:${row.port}`)) {
						await tx.delete(domains).where(eq(domains.id, row.id));
					}
				}
				if (primary) {
					for (const route of spec.routes.slice(1)) {
						const exists = rows.some(
							(row) =>
								!row.primary &&
								row.service === route.service &&
								row.port === route.port,
						);
						if (exists) continue;
						const host = assertHostname(`${route.service}.${primary.host}`);
						// Never claim the panel's own host (APP_URL / panel domain).
						if (reserved.has(host)) {
							throw new AppError("DOMAIN_RESERVED", { host });
						}
						await tx.insert(domains).values({
							appId: app.id,
							host,
							service: route.service,
							port: route.port,
							https: primary.https,
							primary: false,
							provider: primary.provider,
						});
					}
				}
				await tx
					.update(apps)
					.set({
						customSpecEncrypted: encryptCustomSpec(spec),
						needsRedeploy: true,
						updatedAt: new Date(),
					})
					.where(and(eq(apps.id, app.id), eq(apps.teamId, actor.teamId)));
			});
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new AppError("DOMAIN_TAKEN", {
					host: `${spec.routes.map((r) => r.service).join(", ")}.${primary?.host ?? ""}`,
				});
			}
			throw error;
		}
	});
	audit({
		actor,
		action: "app.compose.update",
		targetType: "app",
		targetId: owned.id,
		meta: {
			routes: spec.routes,
			backupVolumes: spec.backupVolumes,
			redeploy: options.redeploy,
		},
	});
	if (!options.redeploy) return { deploymentId: null };
	// A custom compose has no upstream commit: the render pins the digest
	// of the stored compose and env, whatever the mode.
	const { deploymentId } = await startAppJob(
		owned,
		actor,
		"app_redeploy",
		jobTitle("app_redeploy_compose", { app: owned.name }),
		(ctx) => runDeploy(owned.id, "redeploy", undefined, ctx),
	);
	return { deploymentId };
}
