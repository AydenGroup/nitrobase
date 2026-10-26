import { appBaseUrl, getConfig } from "#/config/server.ts";
import { APP_ID } from "#/config/shared.ts";
import { can } from "#/features/auth/access.ts";
import { deploymentStreamResponse } from "#/features/deployments/stream.server.ts";
import { getDeployment } from "#/features/servers/servers.server.ts";
import {
	authenticateToken,
	tokenPublicPart,
} from "#/features/tokens/tokens.server.ts";
import { audit } from "#/server/services/audit.ts";
import {
	localeFromAcceptLanguage,
	serverI18n,
} from "#/server/services/i18n.ts";
import {
	createRateLimiter,
	type RateLimiter,
} from "#/server/services/rate-limit.ts";
import { currentRequestInfo } from "#/server/services/request-info.ts";
import { AppError, getAppErrorMessage } from "#/utils/error.ts";
import { matchApiRoute, openApiDocument } from "./v1";

/**
 * `/api/v1/*`: the bearer-token REST surface. Every operation comes from
 * the registry in #/server/api/v1.ts, which names its permission; this
 * route authenticates the token, rate-limits, checks the permission,
 * validates input with the entry's zod schemas and maps errors to HTTP.
 * Session cookies are ignored here (no CSRF surface); bearer calls are
 * audited through the actions they perform (tagged with the token id).
 */

const globalLimits = globalThis as typeof globalThis & {
	__nitrobaseApiLimiters?: { tokens: RateLimiter; failures: RateLimiter };
};

function limiters() {
	const config = getConfig();
	globalLimits.__nitrobaseApiLimiters ??= {
		tokens: createRateLimiter({
			limit: config.API_RATE_LIMIT,
			windowMs: config.API_RATE_WINDOW_MS,
		}),
		failures: createRateLimiter({
			limit: config.API_RATE_LIMIT,
			windowMs: config.API_RATE_WINDOW_MS,
		}),
	};
	return globalLimits.__nitrobaseApiLimiters;
}

const json = (status: number, body: unknown, headers?: HeadersInit) =>
	Response.json(body, { status, headers });

function errorStatus(code: string): number {
	if (code === "FORBIDDEN") return 403;
	if (code.endsWith("_NOT_FOUND") || code === "NOT_FOUND") return 404;
	if (code === "SERVER_BUSY") return 409;
	return 400;
}

/** Handle one `/api/v1/<splat>` request. */
export async function handleApiRequest(
	request: Request,
	splat: string,
): Promise<Response> {
	const url = new URL(request.url);
	const path = `/${splat}`.replace(/\/+$/, "") || "/";
	if (request.method === "GET" && path === "/openapi.json") {
		const base = appBaseUrl() ?? url.origin;
		return json(200, openApiDocument(base));
	}

	const info = currentRequestInfo();
	const { tokens, failures } = limiters();
	const clientKey = info.ip ?? "unknown";
	if (failures.isLimited(clientKey)) {
		const retry = Math.ceil(failures.retryAfterMs(clientKey) / 1000);
		return json(
			429,
			{ error: "rate_limited" },
			{ "Retry-After": String(retry) },
		);
	}
	const header = request.headers.get("authorization") ?? "";
	const bearer = header.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
	const actor = bearer ? await authenticateToken(bearer, info.ip) : null;
	if (!actor) {
		failures.hit(clientKey);
		audit({
			userId: null,
			teamId: null,
			action: "api.auth_failed",
			meta: {
				path,
				// Only our own public prefix: a pasted foreign secret (a GitHub
				// token, a password) must not land in the audit log.
				prefix: tokenPublicPart(bearer) ?? (bearer ? "malformed" : null),
				reason: bearer ? "invalid" : "missing",
			},
			request: info,
		});
		return json(
			401,
			{ error: "unauthorized", message: "Missing or invalid API token" },
			{ "WWW-Authenticate": `Bearer realm="${APP_ID}"` },
		);
	}
	const tokenKey = actor.tokenId ?? clientKey;
	if (tokens.isLimited(tokenKey)) {
		const retry = Math.ceil(tokens.retryAfterMs(tokenKey) / 1000);
		return json(
			429,
			{ error: "rate_limited" },
			{ "Retry-After": String(retry) },
		);
	}
	tokens.hit(tokenKey);

	const matched = matchApiRoute(request.method, path);
	if (matched === "method") return json(405, { error: "method_not_allowed" });
	if (!matched) return json(404, { error: "not_found" });
	const { route } = matched;
	if (!can(actor, route.permission)) {
		return json(403, { error: "forbidden", permission: route.permission });
	}
	const params = route.params.safeParse(matched.params);
	if (!params.success) {
		return json(400, { error: "bad_request", issues: params.error.issues });
	}
	let rawBody: unknown = {};
	if (request.method === "POST") {
		const text = await request.text();
		if (text.trim()) {
			try {
				rawBody = JSON.parse(text);
			} catch {
				return json(400, {
					error: "bad_request",
					message: "Invalid JSON body",
				});
			}
		}
	}
	const body = route.body ? route.body.safeParse(rawBody) : null;
	if (body && !body.success) {
		return json(400, { error: "bad_request", issues: body.error.issues });
	}

	try {
		if (route.stream) {
			const jobId = (params.data as { jobId: string }).jobId;
			await getDeployment(actor, jobId);
			return deploymentStreamResponse(actor, jobId, request, {
				permission: route.permission,
				coded: false,
			});
		}
		const result = await route.handler({
			actor: { ...actor, gate: route.permission },
			params: params.data,
			body: body?.data ?? {},
			request,
		});
		return json(200, result ?? null);
	} catch (error) {
		if (error instanceof AppError) {
			return json(errorStatus(error.code), {
				error: error.code,
				message: getAppErrorMessage(
					serverI18n(
						localeFromAcceptLanguage(request.headers.get("accept-language")),
					),
					error,
				),
			});
		}
		console.error(`[api] ${request.method} ${path} failed`, error);
		return json(500, { error: "internal_error" });
	}
}
