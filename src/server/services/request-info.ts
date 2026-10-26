import { getRequestHeader, getRequestIP } from "@tanstack/react-start/server";
import { getConfig } from "#/config/server.ts";

export interface RequestInfo {
	ip: string | null;
	userAgent: string | null;
}

const MAX_UA = 400;

/**
 * Client address from X-Forwarded-For: the entry `hops` from the right
 * (each trusted proxy appends the address it saw). Left of that is client
 * supplied and never used. Pure (tested).
 */
export function forwardedClientIp(
	header: string | null | undefined,
	hops: number,
): string | null {
	if (!header) return null;
	const entries = header
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return entries.length >= hops ? entries[entries.length - hops] : null;
}

/**
 * Client address and user agent of the current request (server functions
 * and API routes). Outside a request (jobs, scheduler) both are null.
 * X-Forwarded-For counts only with TRUST_PROXY (see TRUSTED_PROXY_HOPS).
 */
export function currentRequestInfo(): RequestInfo {
	try {
		const config = getConfig();
		const forwarded = config.TRUST_PROXY
			? forwardedClientIp(
					getRequestHeader("x-forwarded-for"),
					config.TRUSTED_PROXY_HOPS,
				)
			: null;
		const ip = forwarded ?? getRequestIP() ?? null;
		const userAgent = getRequestHeader("user-agent")?.slice(0, MAX_UA) ?? null;
		return { ip, userAgent };
	} catch {
		return { ip: null, userAgent: null };
	}
}

/** Same from a raw Request (WebSocket upgrades, where no event exists). */
export function requestInfoFrom(request: { headers: Headers }): RequestInfo {
	const config = getConfig();
	return {
		ip: config.TRUST_PROXY
			? forwardedClientIp(
					request.headers.get("x-forwarded-for"),
					config.TRUSTED_PROXY_HOPS,
				)
			: null,
		userAgent: request.headers.get("user-agent")?.slice(0, MAX_UA) ?? null,
	};
}
