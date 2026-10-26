import { type H3Event, unsealSession } from "h3";
import { resolveSession } from "#/features/auth/sessions.server.ts";
import { type SessionData, sessionConfig } from "#/utils/session";

/**
 * Authenticates a raw `Cookie` header (WebSocket upgrades, where server
 * function middleware doesn't run). Unseals `app-session` and checks the
 * session row, so revoked sessions are rejected. Any failure yields undefined.
 */
export async function getSessionFromCookie(
	cookieHeader: string,
): Promise<{ userId: string; sessionId: string } | undefined> {
	const value = cookieHeader
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith("app-session="))
		?.slice("app-session=".length);
	if (!value) return undefined;

	try {
		// h3 ignores the event argument of unsealSession; a stub is enough.
		const session = await unsealSession(
			{} as H3Event,
			sessionConfig,
			decodeURIComponent(value),
		);
		const resolved = await resolveSession(session.data as SessionData);
		return resolved
			? { userId: resolved.userId, sessionId: resolved.sessionId }
			: undefined;
	} catch {
		return undefined;
	}
}
