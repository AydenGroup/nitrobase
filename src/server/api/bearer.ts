import { getConfig } from "#/config/server.ts";
import { APP_ID } from "#/config/shared.ts";
import type { Actor } from "#/features/auth/access.ts";
import {
	authenticateToken,
	tokenPublicPart,
} from "#/features/tokens/tokens.server.ts";
import { audit } from "#/server/services/audit.ts";
import {
	createRateLimiter,
	type RateLimiter,
} from "#/server/services/rate-limit.ts";
import { currentRequestInfo } from "#/server/services/request-info.ts";

/**
 * Bearer-token authentication shared by the token surfaces (REST
 * `/api/v1`, MCP `/api/mcp`): failed attempts are rate limited per client
 * address and audited (`api.auth_failed`), accepted tokens are rate
 * limited per token. Session cookies are ignored (no CSRF surface).
 */

export type ApiChannel = NonNullable<Actor["channel"]>;

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

const rateLimited = (limiter: RateLimiter, key: string) =>
	Response.json(
		{ error: "rate_limited" },
		{
			status: 429,
			headers: {
				"Retry-After": String(Math.ceil(limiter.retryAfterMs(key) / 1000)),
			},
		},
	);

/**
 * The token's actor (tagged with `channel`), or the 401/429 response to
 * send. `path` lands in the failure audit.
 */
export async function authenticateBearer(
	request: Request,
	{ path, channel }: { path: string; channel: ApiChannel },
): Promise<Actor | Response> {
	const info = currentRequestInfo();
	const { tokens, failures } = limiters();
	const clientKey = info.ip ?? "unknown";
	if (failures.isLimited(clientKey)) return rateLimited(failures, clientKey);
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
				channel,
				// Only our own public prefix: a pasted foreign secret (a GitHub
				// token, a password) must not land in the audit log.
				prefix: tokenPublicPart(bearer) ?? (bearer ? "malformed" : null),
				reason: bearer ? "invalid" : "missing",
			},
			request: info,
		});
		return Response.json(
			{ error: "unauthorized", message: "Missing or invalid API token" },
			{
				status: 401,
				headers: { "WWW-Authenticate": `Bearer realm="${APP_ID}"` },
			},
		);
	}
	const tokenKey = actor.tokenId ?? clientKey;
	if (tokens.isLimited(tokenKey)) return rateLimited(tokens, tokenKey);
	tokens.hit(tokenKey);
	return { ...actor, channel };
}
