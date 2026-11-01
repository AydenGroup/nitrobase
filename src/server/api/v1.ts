import { z } from "zod";
import { appSourceKindOf } from "#/config/app-sources.ts";
import type { Permission } from "#/config/permissions.ts";
import { APP_NAME } from "#/config/shared.ts";
import {
	createAndDeployApp,
	startAppAction,
} from "#/features/apps/app-jobs.server.ts";
import {
	getAppEnvForApi,
	getAppOverview,
	getAppRow,
	listAppDeployments,
	listApps,
} from "#/features/apps/apps.server.ts";
import { readAppLogs } from "#/features/apps/logs.server.ts";
import { runPreflight } from "#/features/apps/preflight.server.ts";
import {
	CreateAppSchema,
	PreflightInputSchema,
	serviceName,
} from "#/features/apps/schema.ts";
import type { Actor } from "#/features/auth/access.ts";
import { listBackups } from "#/features/backups/backups.server.ts";
import { listDestinations } from "#/features/backups/destinations.server.ts";
import { startAppBackup } from "#/features/backups/jobs.server.ts";
import { listJobs } from "#/features/deployments/jobs.server.ts";
import { JobFiltersSchema } from "#/features/deployments/schema.ts";
import { serverHistory } from "#/features/monitoring/monitoring.server.ts";
import { ServerHistoryInputSchema } from "#/features/monitoring/schema.ts";
import {
	getDeployment,
	getServer,
	listServerSummaries,
	listServers,
} from "#/features/servers/servers.server.ts";
import { TemplateVersionsInputSchema } from "#/features/templates/schema.ts";
import {
	getTemplateManifest,
	getTemplateVersions,
	listTemplates,
} from "#/features/templates/templates.server.ts";
import { serverI18n } from "#/server/services/i18n.ts";
import { AppError } from "#/utils/error.ts";

/**
 * Versioned REST surface (`/api/v1`, `Authorization: Bearer nbk_…`). One
 * registry entry per operation: method, path template, the permission it
 * needs (checked before the handler), zod schemas for path params and the
 * JSON body (validated, and turned into the OpenAPI document). Add an
 * endpoint = add an entry; it is gated and documented automatically.
 */
interface ApiContext<P, B> {
	actor: Actor;
	params: P;
	body: B;
	request: Request;
}

export interface ApiRoute<P = unknown, B = unknown> {
	id: string;
	method: "GET" | "POST";
	/** `/apps/{appId}` style template, relative to /api/v1. */
	path: string;
	permission: Permission;
	summary: string;
	params: z.ZodType<P>;
	body?: z.ZodType<B>;
	/** Server-sent events instead of JSON. */
	stream?: boolean;
	handler: (ctx: ApiContext<P, B>) => Promise<unknown>;
}

const route = <P, B>(definition: ApiRoute<P, B>) =>
	definition as unknown as ApiRoute;

const id = z.guid();
const none = z.object({});

/** Field docs of a new app (pre-flight and create bodies). */
const newAppDocs = {
	templateId: "Template id from listTemplates (marketplace templates only)",
	serverId: "A ready server of the team (listServers)",
	version: "A `ref` from listTemplateVersions; omitted: the template's default",
	domain:
		"Primary host name pointing to the server; empty or omitted: a free generated domain",
	inputs:
		"Template variable values by name (the template's `inputs`); empty values keep the default",
	name: "Display name of the app",
	acknowledged:
		"Set true to accept the warnings of an `advanced` template or one needing extra security permissions (else TEMPLATE_ACK_REQUIRED); recorded in the audit log",
} as const;

function describeFields<S extends z.ZodRawShape>(shape: S): S {
	return Object.fromEntries(
		Object.entries(shape).map(([name, schema]) => {
			const text = newAppDocs[name as keyof typeof newAppDocs];
			return [name, text ? (schema as z.ZodType).describe(text) : schema];
		}),
	) as S;
}

/** A new app as the deploy wizard sends it to the pre-flight. */
const preflightBody = z.object(describeFields(PreflightInputSchema.shape));

/**
 * The wizard's create input (same constraints) for marketplace templates:
 * databases, git and custom compose have their own fields and flows.
 * Validation messages are the source (English) ones.
 */
const createAppBody = z.object(
	describeFields(
		CreateAppSchema(serverI18n()).omit({
			custom: true,
			git: true,
			database: true,
		}).shape,
	),
);

/** Only marketplace templates are created through the API. */
async function assertApiTemplate(templateId: string): Promise<void> {
	const manifest = await getTemplateManifest(templateId);
	if (appSourceKindOf(manifest.source.type) !== "template") {
		throw new AppError("TEMPLATE_API_UNSUPPORTED", { template: templateId });
	}
}

const apiRoutes: ApiRoute[] = [
	route({
		id: "listServers",
		method: "GET",
		path: "/servers",
		permission: "server.view",
		summary: "List the team's servers",
		params: none,
		handler: ({ actor }) => listServers(actor),
	}),
	route({
		id: "getServer",
		method: "GET",
		path: "/servers/{serverId}",
		permission: "server.view",
		summary: "Get one server",
		params: z.object({ serverId: id }),
		handler: async ({ actor, params }) => {
			const server = await getServer(actor, params.serverId);
			if (!server) throw new AppError("SERVER_NOT_FOUND");
			return server;
		},
	}),
	route({
		id: "listApps",
		method: "GET",
		path: "/apps",
		permission: "app.view",
		summary: "List the team's apps",
		params: none,
		handler: ({ actor }) => listApps(actor),
	}),
	route({
		id: "getApp",
		method: "GET",
		path: "/apps/{appId}",
		permission: "app.view",
		summary: "Get one app (domains, services; secrets masked)",
		params: z.object({ appId: id }),
		handler: ({ actor, params }) => getAppOverview(actor, params.appId),
	}),
	route({
		id: "deployApp",
		method: "POST",
		path: "/apps/{appId}/deploy",
		permission: "app.deploy",
		summary:
			"Deploy: without a version, redeploy the pinned commit; with one, update to it",
		params: z.object({ appId: id }),
		body: z.object({
			version: z
				.string()
				.regex(/^[\w][\w./@-]{0,199}$/)
				.optional(),
			backupFirst: z.boolean().optional(),
			confirmDowngrade: z
				.boolean()
				.optional()
				.describe(
					"Required (true) when `version` is older than the deployed one: data migrations may not be reversible, so restore a backup if the app fails. A downgrade without it is refused (APP_DOWNGRADE_UNCONFIRMED).",
				),
		}),
		handler: ({ actor, params, body }) =>
			startAppAction(
				actor,
				body.version
					? {
							appId: params.appId,
							action: "update",
							version: body.version,
							backupFirst: body.backupFirst ?? false,
							confirmDowngrade: body.confirmDowngrade ?? false,
						}
					: { appId: params.appId, action: "redeploy" },
			),
	}),
	route({
		id: "redeployApp",
		method: "POST",
		path: "/apps/{appId}/redeploy",
		permission: "app.deploy",
		summary: "Redeploy the app at its pinned commit",
		params: z.object({ appId: id }),
		handler: ({ actor, params }) =>
			startAppAction(actor, { appId: params.appId, action: "redeploy" }),
	}),
	route({
		id: "restartApp",
		method: "POST",
		path: "/apps/{appId}/restart",
		permission: "app.deploy",
		summary: "Restart the app, or one service of it",
		params: z.object({ appId: id }),
		body: z.object({
			service: z
				.string()
				.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
				.optional(),
		}),
		handler: ({ actor, params, body }) =>
			startAppAction(actor, {
				appId: params.appId,
				action: "restart",
				service: body.service,
			}),
	}),
	route({
		id: "backupApp",
		method: "POST",
		path: "/apps/{appId}/backups",
		permission: "backup.create",
		summary:
			"Back up the app now (to `destinationId`, else its schedule's destination)",
		params: z.object({ appId: id }),
		body: z.object({ destinationId: id.optional() }),
		handler: ({ actor, params, body }) =>
			startAppBackup(actor, {
				appId: params.appId,
				destinationId: body.destinationId,
			}),
	}),
	route({
		id: "getJob",
		method: "GET",
		path: "/jobs/{jobId}",
		permission: "server.view",
		summary: "Status of a job (deploy, backup...)",
		params: z.object({ jobId: id }),
		handler: ({ actor, params }) => getDeployment(actor, params.jobId),
	}),
	route({
		id: "streamJob",
		method: "GET",
		path: "/jobs/{jobId}/stream",
		permission: "server.view",
		summary:
			"Job log as server-sent events (`log` lines, then `complete`); resumes with Last-Event-ID",
		params: z.object({ jobId: id }),
		stream: true,
		// Handled by the route (needs the raw request and a streaming body).
		handler: async () => null,
	}),

	// Operating apps (also what AI agents get as tools): each entry calls the
	// feature function its UI server function calls, with the token's actor.
	route({
		id: "listAppDeployments",
		method: "GET",
		path: "/apps/{appId}/deployments",
		permission: "app.view",
		summary:
			"List the app's deployment history (newest first, last 50): job id, type, status, error, commit, timestamps. Use getJob for one job's details",
		params: z.object({ appId: id }),
		handler: ({ actor, params }) => listAppDeployments(actor, params.appId),
	}),
	route({
		id: "getAppLogs",
		method: "POST",
		path: "/apps/{appId}/logs",
		permission: "app.view",
		summary:
			"Read-only: the last `tail` container log lines of the app, or of one `service`, as text (not followed), with the app's secret values masked. Returns { service, tail, text, truncated }: at most APP_LOGS_API_MAX_BYTES of the newest lines (truncated: older lines were cut)",
		params: z.object({ appId: id }),
		body: z.object({
			service: serviceName
				.optional()
				.describe(
					"One compose service (see getApp's services); omitted: all services",
				),
			tail: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe(
					"Lines to return; capped by the instance maximum (APP_LOGS_TAIL_MAX), default APP_LOGS_TAIL_DEFAULT",
				),
			timestamps: z
				.boolean()
				.optional()
				.describe("Prefix each line with its timestamp (default true)"),
		}),
		handler: ({ actor, params, body }) =>
			readAppLogs(actor, { appId: params.appId, ...body }),
	}),
	route({
		id: "startApp",
		method: "POST",
		path: "/apps/{appId}/start",
		permission: "app.deploy",
		summary:
			"Start the stopped app, or one `service` of it. Returns { deploymentId }: a job id; poll getJob",
		params: z.object({ appId: id }),
		body: z.object({
			service: serviceName.optional().describe("Only this compose service"),
		}),
		handler: ({ actor, params, body }) =>
			startAppAction(actor, {
				appId: params.appId,
				action: "start",
				service: body.service,
			}),
	}),
	route({
		id: "stopApp",
		method: "POST",
		path: "/apps/{appId}/stop",
		permission: "app.deploy",
		summary:
			"Stop the app (its containers; data is kept), or one `service` of it. Returns { deploymentId }: a job id; poll getJob",
		params: z.object({ appId: id }),
		body: z.object({
			service: serviceName.optional().describe("Only this compose service"),
		}),
		handler: ({ actor, params, body }) =>
			startAppAction(actor, {
				appId: params.appId,
				action: "stop",
				service: body.service,
			}),
	}),
	route({
		id: "getAppEnv",
		method: "GET",
		path: "/apps/{appId}/env",
		permission: "app.view",
		summary:
			"The app's environment variables with secret values masked (also copies of secrets and URL credentials): `.env` text plus per-variable metadata (secret, template, locked, needsRedeploy). Never returns secret values",
		params: z.object({ appId: id }),
		handler: ({ actor, params }) => getAppEnvForApi(actor, params.appId),
	}),
	route({
		id: "listTemplates",
		method: "GET",
		path: "/templates",
		permission: "app.view",
		summary:
			"List the app templates that can be deployed: id, name, description, category, editable inputs, requirements, `advanced` (createApp then needs acknowledged)",
		params: none,
		handler: () => listTemplates(),
	}),
	route({
		id: "listTemplateVersions",
		method: "GET",
		path: "/templates/{templateId}/versions",
		permission: "app.view",
		summary:
			"Stable versions a template can deploy, and the default one (`defaultRef`). Pass a `ref` as createApp's `version`",
		params: z.object({
			templateId: TemplateVersionsInputSchema.shape.templateId,
		}),
		handler: ({ params }) => getTemplateVersions(params.templateId),
	}),
	route({
		id: "preflightApp",
		method: "POST",
		path: "/apps/preflight",
		permission: "app.deploy",
		summary:
			"Read-only pre-flight of a new app (server ready, resources, ports, domain, version): returns { ok, checks }; createApp is refused while ok is false",
		params: none,
		body: preflightBody,
		handler: async ({ actor, body }) => {
			await assertApiTemplate(body.templateId);
			return runPreflight(actor, {
				...body,
				domain: body.domain || undefined,
			});
		},
	}),
	route({
		id: "createApp",
		method: "POST",
		path: "/apps",
		permission: "app.deploy",
		summary:
			"Create an app from a marketplace template on a server and deploy it (databases, git repositories and custom compose are refused: TEMPLATE_API_UNSUPPORTED). `acknowledged: true` means the caller accepts the template's security/advanced warnings (audited). Runs the pre-flight first: if a check fails nothing is created and { preflight } is returned. Otherwise returns { appId, deploymentId }: a job id; poll getJob",
		params: none,
		body: createAppBody,
		handler: async ({ actor, body }) => {
			await assertApiTemplate(body.templateId);
			const preflight = await runPreflight(actor, {
				...body,
				domain: body.domain || undefined,
			});
			if (!preflight.ok) return { preflight };
			return createAndDeployApp(actor, body);
		},
	}),
	route({
		id: "getServerHealth",
		method: "GET",
		path: "/servers/{serverId}/health",
		permission: "server.view",
		summary:
			"Latest health of one server (CPU, memory, disk, load, last sample time), its app and database counts, and the alert thresholds",
		params: z.object({ serverId: id }),
		handler: async ({ actor, params }) => {
			const server = await getServer(actor, params.serverId);
			if (!server) throw new AppError("SERVER_NOT_FOUND");
			const { servers, thresholds } = await listServerSummaries(actor);
			const summary = servers.find((item) => item.serverId === server.id);
			return { ...summary, thresholds };
		},
	}),
	route({
		id: "getServerMetrics",
		method: "GET",
		path: "/servers/{serverId}/metrics/{range}",
		permission: "monitoring.view",
		summary:
			"Metric history of one server over `range` (1h, 24h, 7d): binned CPU, load, memory, swap, network and disk series",
		params: ServerHistoryInputSchema,
		handler: async ({ actor, params }) => {
			const server = await getServer(actor, params.serverId);
			if (!server) throw new AppError("SERVER_NOT_FOUND");
			return serverHistory(server.id, params.range);
		},
	}),
	route({
		id: "listAppBackups",
		method: "GET",
		path: "/apps/{appId}/backups",
		permission: "backup.view",
		summary:
			"List the app's backups (newest first): id, status, kind, size, destination, timestamps. Start one with backupApp",
		params: z.object({ appId: id }),
		handler: async ({ actor, params }) => {
			// Unknown or foreign apps are APP_NOT_FOUND; databases need their view.
			await getAppRow(actor, params.appId, "backup.view");
			return listBackups(actor, { appId: params.appId });
		},
	}),
	route({
		id: "listBackupDestinations",
		method: "GET",
		path: "/backups/destinations",
		permission: "backup.view",
		summary:
			"List the team's backup destinations as { id, name, type } (no credentials). Pass an id as backupApp's destinationId",
		params: none,
		handler: async ({ actor }) =>
			(await listDestinations(actor)).map((row) => ({
				id: row.id,
				name: row.name,
				type: row.type,
			})),
	}),
	route({
		id: "listJobs",
		method: "GET",
		path: "/jobs",
		permission: "server.view",
		summary:
			"List the team's most recent jobs (deploys, backups, server actions; newest first) with status, app and server. Use getJob or streamJob for one",
		params: none,
		handler: ({ actor }) => listJobs(actor, JobFiltersSchema.parse({})),
	}),
];

/** Match `/apps/123/deploy` against the registry; params as strings. */
export function matchApiRoute(
	method: string,
	path: string,
): { route: ApiRoute; params: Record<string, string> } | "method" | null {
	const parts = path.split("/").filter(Boolean);
	let methodMismatch = false;
	for (const candidate of apiRoutes) {
		const template = candidate.path.split("/").filter(Boolean);
		if (template.length !== parts.length) continue;
		const params: Record<string, string> = {};
		const ok = template.every((segment, index) => {
			const name = segment.match(/^\{(\w+)\}$/)?.[1];
			if (name) {
				params[name] = decodeURIComponent(parts[index]);
				return true;
			}
			return segment === parts[index];
		});
		if (!ok) continue;
		if (candidate.method !== method) {
			methodMismatch = true;
			continue;
		}
		return { route: candidate, params };
	}
	return methodMismatch ? "method" : null;
}

/** OpenAPI 3.1 document generated from the registry. */
export function openApiDocument(baseUrl: string): Record<string, unknown> {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const entry of apiRoutes) {
		const params = z.toJSONSchema(entry.params) as {
			properties?: Record<string, unknown>;
		};
		const operation: Record<string, unknown> = {
			operationId: entry.id,
			summary: entry.summary,
			description: `Requires the \`${entry.permission}\` permission.`,
			"x-permission": entry.permission,
			security: [{ bearer: [] }],
			parameters: Object.entries(params.properties ?? {}).map(
				([name, schema]) => ({ name, in: "path", required: true, schema }),
			),
			responses: entry.stream
				? { "200": { description: "text/event-stream" } }
				: {
						"200": {
							description: "OK",
							content: { "application/json": { schema: {} } },
						},
						"401": {
							description: "Missing, invalid, revoked or expired token",
						},
						"403": { description: "The token lacks the permission" },
						"404": { description: "Not found in the token's team" },
						"429": { description: "Rate limited" },
					},
		};
		if (entry.body) {
			operation.requestBody = {
				required: false,
				content: {
					"application/json": { schema: z.toJSONSchema(entry.body) },
				},
			};
		}
		paths[entry.path] ??= {};
		paths[entry.path][entry.method.toLowerCase()] = operation;
	}
	return {
		openapi: "3.1.0",
		info: {
			title: `${APP_NAME} API`,
			version: "1",
			description:
				"Team-scoped automation API. Create tokens in Settings → API tokens.",
		},
		servers: [{ url: `${baseUrl}/api/v1` }],
		components: {
			securitySchemes: {
				bearer: { type: "http", scheme: "bearer", bearerFormat: "nbk_…" },
			},
		},
		paths,
	};
}
