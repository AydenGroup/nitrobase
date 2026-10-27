import { z } from "zod";
import type { Permission } from "#/config/permissions.ts";
import { APP_NAME } from "#/config/shared.ts";
import { startAppAction } from "#/features/apps/app-jobs.server.ts";
import { getAppOverview, listApps } from "#/features/apps/apps.server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { startAppBackup } from "#/features/backups/jobs.server.ts";
import {
	getDeployment,
	getServer,
	listServers,
} from "#/features/servers/servers.server.ts";
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
