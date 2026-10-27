import { eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { servers } from "#/db/schema/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { withAppServerLock } from "#/features/deployments/deployments.server.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import { audit } from "#/server/services/audit.ts";
import {
	effectiveLimits,
	evaluateOvercommit,
	type OvercommitResult,
} from "#/server/services/templates/resources.ts";
import { AppError } from "#/utils/error.ts";
import {
	appInputs,
	effectiveAppResources,
	getAppManifest,
	getAppRow,
	getAppServer,
	storedAppInputs,
} from "./apps.server";
import type {
	AppResourcesInput,
	AppRow,
	AppServiceResources,
	ResourcesPreview,
} from "./schema";

/**
 * Per-app resource limits (M6). Overrides live in `apps.inputs.resources`
 * and take effect on the next deploy (the app is flagged needs-redeploy).
 * A server with `require_limits` refuses a service without a memory limit
 * (unless the server gives a default one).
 */

/**
 * Sum of a services' limits as they will run: the app's effective limit
 * (overrides, then template defaults), else what the compose itself
 * declares, else the server's default limit on a strict server (the same
 * fallback `renderApp` applies).
 */
export function sumLimits(
	services: {
		effective?: { memoryMb: number | null; cpus: number | null };
		declared?: { memoryMb: number | null; cpus: number | null };
	}[],
	server: Pick<ServerRow, "requireLimits" | "defaultMemoryMb">,
): { memoryMb: number; cpus: number } {
	const fallback =
		server.requireLimits && server.defaultMemoryMb ? server.defaultMemoryMb : 0;
	let memoryMb = 0;
	let cpus = 0;
	for (const service of services) {
		memoryMb +=
			service.effective?.memoryMb ?? service.declared?.memoryMb ?? fallback;
		cpus += service.effective?.cpus ?? service.declared?.cpus ?? 0;
	}
	return { memoryMb, cpus };
}

/** Limits a deployed compose actually sets, per service. */
function declaredLimits(
	app: Pick<AppRow, "composeDeployed">,
): Map<string, { memoryMb: number | null; cpus: number | null }> {
	const out = new Map<
		string,
		{ memoryMb: number | null; cpus: number | null }
	>();
	if (!app.composeDeployed) return out;
	try {
		const model = parseYaml(app.composeDeployed) as {
			services?: Record<string, unknown>;
		};
		for (const [name, service] of Object.entries(model?.services ?? {})) {
			out.set(name, effectiveLimits(service));
		}
	} catch {
		// An unreadable compose counts as "no limits".
	}
	return out;
}

/**
 * Limits of every app on a server, in one query: deployed apps count what
 * their deployed compose sets (no template fetch per app); apps not
 * deployed yet count their template defaults.
 */
export async function serverLimitTotals(
	server: Pick<ServerRow, "id" | "requireLimits" | "defaultMemoryMb">,
	options: { excludeAppId?: string } = {},
): Promise<{ memoryMb: number; cpus: number }> {
	const rows = await db.select().from(apps).where(eq(apps.serverId, server.id));
	const services: Parameters<typeof sumLimits>[0] = [];
	for (const app of rows) {
		if (app.id === options.excludeAppId) continue;
		const declared = declaredLimits(app);
		if (declared.size) {
			for (const limits of declared.values())
				services.push({ declared: limits });
			continue;
		}
		const manifest = await getAppManifest(app).catch(() => null);
		for (const item of effectiveAppResources(app, manifest)) {
			services.push({ effective: item });
		}
	}
	return sumLimits(services, server);
}

/** Server facts for the overcommit check (one round-trip). */
export async function serverCapacity(executor: {
	exec(command: string): Promise<{ stdout: string }>;
}): Promise<{ memoryMb: number | null; cpus: number | null }> {
	const result = await executor.exec(
		"awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null; nproc 2>/dev/null",
	);
	const [memKb, cores] = result.stdout.trim().split(/\s+/).map(Number);
	return {
		memoryMb: Number.isFinite(memKb) && memKb > 0 ? memKb / 1024 : null,
		cpus: Number.isFinite(cores) && cores > 0 ? cores : null,
	};
}

/** Every service must end up with a memory limit on a strict server. */
function assertLimitsPolicy(
	server: Pick<ServerRow, "requireLimits" | "defaultMemoryMb">,
	effective: Pick<AppServiceResources, "service" | "memoryMb">[],
): void {
	if (!server.requireLimits || server.defaultMemoryMb) return;
	const missing = effective.find((item) => !item.memoryMb);
	if (missing) {
		throw new AppError("RESOURCES_REQUIRED", { service: missing.service });
	}
}

function validated(
	input: AppResourcesInput["resources"],
	known: Set<string>,
): NonNullable<ReturnType<typeof appInputs>["resources"]> {
	const out: NonNullable<ReturnType<typeof appInputs>["resources"]> = {};
	for (const [service, limits] of Object.entries(input)) {
		if (!known.has(service)) {
			throw new AppError("APP_SERVICE_NOT_FOUND", { service });
		}
		out[service] = limits;
	}
	return out;
}

/** Effective limits if `resources` were saved (no write). */
async function previewFor(
	actor: Actor,
	appId: string,
	resources: AppResourcesInput["resources"],
): Promise<{
	effective: AppServiceResources[];
	next: NonNullable<ReturnType<typeof appInputs>["resources"]>;
}> {
	const app = await getAppRow(actor, appId, "app.resources.manage");
	const manifest = await getAppManifest(app).catch(() => null);
	const current = effectiveAppResources(app, manifest);
	const known = new Set(current.map((item) => item.service));
	const next = {
		...(appInputs(app).resources ?? {}),
		...validated(resources, known),
	};
	const effective = effectiveAppResources(
		{ ...app, inputs: storedAppInputs({ ...appInputs(app), resources: next }) },
		manifest,
	);
	return { effective, next };
}

/**
 * What saving would mean on this server: the sum of every app's limits
 * against its RAM/cores (a warning, never a refusal).
 */
export async function previewAppResources(
	actor: Actor,
	input: AppResourcesInput,
	capacity: (server: ServerRow) => Promise<{
		memoryMb: number | null;
		cpus: number | null;
	}>,
): Promise<ResourcesPreview> {
	const { effective } = await previewFor(actor, input.appId, input.resources);
	const app = await getAppRow(actor, input.appId);
	const server = await getAppServer(app);
	const others = await serverLimitTotals(server, { excludeAppId: app.id });
	const declared = declaredLimits(app);
	const own = sumLimits(
		effective.map((item) => ({
			effective:
				item.memoryMb || item.cpus
					? { memoryMb: item.memoryMb, cpus: item.cpus }
					: undefined,
			declared: declared.get(item.service),
		})),
		server,
	);
	const overcommit: OvercommitResult = evaluateOvercommit(
		{ memoryMb: others.memoryMb + own.memoryMb, cpus: others.cpus + own.cpus },
		await capacity(server).catch(() => ({ memoryMb: null, cpus: null })),
		getConfig().RESOURCE_OVERCOMMIT_PERCENT,
	);
	let policyError: string | null = null;
	try {
		assertLimitsPolicy(server, effective);
	} catch (error) {
		if (!(error instanceof AppError)) throw error;
		policyError = (error.params as { service?: string }).service ?? "";
	}
	return { effective, overcommit, missingLimit: policyError };
}

export async function updateAppResources(
	actor: Actor,
	input: AppResourcesInput,
): Promise<void> {
	const owned = await getAppRow(actor, input.appId, "app.resources.manage");
	await withAppServerLock(owned, async () => {
		const { effective, next } = await previewFor(
			actor,
			input.appId,
			input.resources,
		);
		const [server] = await db
			.select()
			.from(servers)
			.where(eq(servers.id, owned.serverId))
			.limit(1);
		if (server) assertLimitsPolicy(server, effective);
		const app = await getAppRow(actor, input.appId, "app.resources.manage");
		await db
			.update(apps)
			.set({
				inputs: storedAppInputs({ ...appInputs(app), resources: next }),
				needsRedeploy: true,
				updatedAt: new Date(),
			})
			.where(eq(apps.id, app.id));
		audit({
			actor,
			action: "app.resources.update",
			targetType: "app",
			targetId: app.id,
			meta: { resources: next },
		});
	});
}
