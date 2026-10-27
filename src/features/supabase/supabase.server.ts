import { getConfig } from "#/config/server.ts";
import {
	appInputs,
	appOverrides,
	containerName,
	deployedServices,
	getAppManifest,
	getAppRow,
	getAppServer,
	listAppDomains,
	readEnvValues,
} from "#/features/apps/apps.server.ts";
import {
	type AppRow,
	type DomainRow,
	rotateHookView,
} from "#/features/apps/schema.ts";
import type { Actor } from "#/features/auth/access.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import type { TemplateManifest } from "#/features/templates/schema.ts";
import { hasCapability } from "#/plugins/registry.ts";
import type { PluginCapability } from "#/plugins/types.ts";
import type { Executor } from "#/server/services/executor.ts";
import {
	curlConfig,
	type GatewayMethod,
	gatewayCommand,
	gatewayError,
	parseGatewayResponse,
} from "#/server/services/gateway.ts";
import { versionAtLeast } from "#/server/services/templates/render.ts";
import { basicAuthByService } from "#/server/services/templates/route-auth.ts";
import { AppError } from "#/utils/error.ts";
import {
	type HttpResult,
	type SupabaseOverview,
	type SupabasePluginConfig,
	SupabasePluginConfigSchema,
} from "./schema";

export interface SupabaseContext {
	app: AppRow;
	server: ServerRow;
	config: SupabasePluginConfig;
	/** Current env values (secrets: server-only). */
	values: Record<string, string>;
	domains: DomainRow[];
	container: (service: string) => string;
}

/**
 * Load an app for a plugin action: owner check, the template's plugin must
 * declare `capability`, and its `[plugin]` config must parse.
 */
export async function supabaseContext(
	actor: Actor,
	appId: string,
	capability: PluginCapability,
): Promise<SupabaseContext> {
	const app = await getAppRow(actor, appId);
	if (!hasCapability(app.templateId, capability)) {
		throw new AppError("PLUGIN_CAPABILITY_MISSING");
	}
	const manifest = await getAppManifest(app);
	const parsed = SupabasePluginConfigSchema.safeParse(manifest.plugin);
	if (!parsed.success) {
		throw new AppError("PLUGIN_CONFIG_INVALID", {
			detail: parsed.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("\n"),
		});
	}
	return {
		app,
		server: await getAppServer(app),
		config: parsed.data,
		values: { ...readEnvValues(app), ...appOverrides(app) },
		domains: await listAppDomains(app.id),
		container: (service) => containerName(app.folder, service),
	};
}

/** The service must be part of the deployed app. */
export function requireDeployed(ctx: SupabaseContext, service: string): void {
	if (!deployedServices(ctx.app).includes(service)) {
		throw new AppError("SERVICE_NOT_RUNNING", { service });
	}
}

export async function withExecutor<T>(
	ctx: SupabaseContext,
	fn: (executor: Executor) => Promise<T>,
): Promise<T> {
	const executor = await getExecutor(ctx.server);
	try {
		return await fn(executor);
	} finally {
		executor.close();
	}
}

const urlOf = (domain: DomainRow | undefined) =>
	domain ? `${domain.https ? "https" : "http"}://${domain.host}` : null;

/**
 * Whether the app has the new API keys: its values hold both opaque keys,
 * or its release defines them (generated on the next deploy), or not.
 */
export function newKeysState(
	config: Pick<SupabasePluginConfig, "publishable_key" | "secret_key">,
	values: Record<string, string>,
	manifest: Pick<TemplateManifest, "variables">,
	version: string,
): { state: SupabaseOverview["newKeys"]; minVersion: string | null } {
	const names = [config.publishable_key, config.secret_key];
	const variables = names.map((name) =>
		name ? manifest.variables[name] : undefined,
	);
	if (!variables.every(Boolean))
		return { state: "unsupported", minVersion: null };
	const minVersion =
		variables.map((variable) => variable?.min_version).find(Boolean) ?? null;
	if (names.every((name) => name && values[name])) {
		return { state: "ready", minVersion };
	}
	return {
		state: versionAtLeast(version, minVersion ?? undefined)
			? "redeploy"
			: "update",
		minVersion,
	};
}

export async function getSupabaseOverview(
	actor: Actor,
	appId: string,
): Promise<SupabaseOverview> {
	const ctx = await supabaseContext(actor, appId, "api-keys");
	const { config, values } = ctx;
	const manifest = await getAppManifest(ctx.app);
	const primary = ctx.domains.find((domain) => domain.primary);
	const studio = ctx.domains.find(
		(domain) => domain.service === config.studio_service,
	);
	const published = appInputs(ctx.app).publishedPorts ?? {};
	const loopback = new Set(appInputs(ctx.app).loopbackPorts ?? []);
	const tenant = values[config.pooler_tenant] ?? ctx.app.folder;
	const keys = newKeysState(config, values, manifest, ctx.app.version);
	const apiUrl = urlOf(primary);
	return {
		apiUrl,
		storageRepair:
			!!config.storage_files &&
			hasCapability(ctx.app.templateId, "storage-repair"),
		newKeys: keys.state,
		newKeysVersion: keys.minVersion,
		publishableKey:
			keys.state === "ready" && config.publishable_key
				? (values[config.publishable_key] ?? null)
				: null,
		secretKeyName:
			keys.state === "ready" && config.secret_key ? config.secret_key : null,
		secretKeyRotatable:
			keys.state === "ready" &&
			!!config.secret_key &&
			!!manifest.variables[config.secret_key]?.rotatable,
		jwksUrl:
			keys.state === "ready" && apiUrl && config.jwks_path
				? `${apiUrl}${config.jwks_path}`
				: null,
		// Without its own domain, Studio is served by the gateway at "/".
		studioUrl: urlOf(studio) ?? urlOf(primary),
		studioProtected:
			!!studio && basicAuthByService(manifest).has(config.studio_service),
		anonKey: values[config.anon_key] ?? null,
		serviceKeyName: config.service_key,
		jwtSecretName: config.jwt_secret,
		jwtSecretRotateHook: rotateHookView(
			manifest.variables[config.jwt_secret]?.on_rotate,
		),
		studioUsername: values[config.studio_username] ?? null,
		studioPasswordName: config.studio_password,
		dbPasswordName: config.db_password,
		functionsService: config.functions_service,
		dbService: config.db_service,
		pooler: config.pooler_ports.flatMap((id) => {
			const port = manifest.ports.find((item) => item.id === id);
			const hostPort = published[id];
			if (!port || !hostPort) return [];
			return [
				{
					label: port.label,
					hostPort,
					loopback: loopback.has(id),
					// Password placeholder: the value is revealed in Environment.
					// Loopback ports are reached through `ssh -L` on this machine.
					connection: `postgresql://postgres.${tenant}:[${config.db_password}]@${loopback.has(id) ? "127.0.0.1" : ctx.server.host}:${hostPort}/postgres`,
				},
			];
		}),
	};
}

/**
 * Gateway headers for the anon or service_role key: the new opaque key
 * (publishable / secret) when the app has one, else the legacy JWT. An
 * opaque key goes in `apikey` only (the gateway swaps it for a JWT); a
 * legacy key is also the bearer token. Null without any key.
 */
export function gatewayAuthHeaders(
	config: Pick<
		SupabasePluginConfig,
		"anon_key" | "service_key" | "publishable_key" | "secret_key"
	>,
	values: Record<string, string>,
	key: "anon" | "service",
): Record<string, string> | null {
	const opaqueName =
		key === "service" ? config.secret_key : config.publishable_key;
	const opaque = opaqueName ? values[opaqueName] : undefined;
	if (opaque) return { apikey: opaque };
	const legacy =
		values[key === "service" ? config.service_key : config.anon_key];
	if (!legacy) return null;
	return { apikey: legacy, Authorization: `Bearer ${legacy}` };
}

/**
 * HTTP request to the app's API gateway from a throwaway container on the
 * proxy network (see gateway.ts). `key` picks the anon or service_role key
 * (see `gatewayAuthHeaders`); keys travel in the curl config on stdin.
 */
export async function gatewayRequest(
	ctx: SupabaseContext,
	input: {
		path: string;
		method: GatewayMethod;
		key: "anon" | "service";
		body?: string;
		headers?: Record<string, string>;
	},
): Promise<HttpResult> {
	const config = getConfig();
	requireDeployed(ctx, ctx.config.api_service);
	const auth = gatewayAuthHeaders(ctx.config, ctx.values, input.key);
	if (!auth) throw new AppError("SERVICE_NOT_RUNNING", { service: "api" });
	const body = input.method === "GET" ? undefined : input.body;
	if (
		body !== undefined &&
		Buffer.byteLength(body, "utf8") > config.SUPABASE_HTTP_MAX_BODY_BYTES
	) {
		throw new AppError("HTTP_BODY_TOO_LARGE", {
			max: { $bytes: config.SUPABASE_HTTP_MAX_BODY_BYTES },
		});
	}
	const request = {
		network: config.NITROBASE_NETWORK,
		image: config.APP_HEALTH_IMAGE,
		container: ctx.container(ctx.config.api_service),
		port: ctx.config.api_port,
		path: input.path,
		method: input.method,
		headers: {
			...auth,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			...input.headers,
		},
		body,
		timeoutMs: config.SUPABASE_HTTP_TIMEOUT_MS,
		maxResponseBytes: config.SUPABASE_HTTP_MAX_RESPONSE_BYTES,
	};
	const started = Date.now();
	const result = await withExecutor(ctx, (executor) =>
		executor.exec(gatewayCommand(request), {
			input: curlConfig(request),
			timeoutMs:
				config.SUPABASE_HTTP_TIMEOUT_MS + config.SUPABASE_EXEC_SLACK_MS,
		}),
	);
	const elapsed = Date.now() - started;
	const parsed = parseGatewayResponse(
		result.stdout,
		result.stderr,
		config.SUPABASE_HTTP_MAX_RESPONSE_BYTES,
	);
	return {
		status: parsed.status,
		headers: parsed.headers,
		body: parsed.body,
		timeMs:
			parsed.timeSeconds !== null
				? Math.round(parsed.timeSeconds * 1000)
				: elapsed,
		truncated: parsed.truncated,
		error:
			parsed.status === null
				? gatewayError(result.stderr) || "No response"
				: null,
	};
}
