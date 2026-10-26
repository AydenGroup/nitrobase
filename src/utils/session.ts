import { useSession as sealedSession } from "@tanstack/react-start/server";
import { isSecureAppUrl } from "./env";

export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
export const REMEMBER_ME_MAX_AGE = 30 * 24 * 60 * 60;

/** Payload sealed (encrypted + signed) into the `app-session` cookie. */
export type SessionData = {
	/** Server-side session row (`sessions.id`); revoking it logs out. */
	sid?: string;
	userId?: string;
	email?: string;
	/** Password accepted, 2FA code still due (no access until verified). */
	pending2fa?: { userId: string; rememberMe: boolean; at: number };
};

/**
 * Shared by TanStack's `useSession` and the raw h3 helpers (WebSocket
 * upgrades), so both seal/unseal the same cookie. `SESSION_SECRET` is the
 * sealing key and must stay stable, or every session is invalidated.
 */
export const sessionConfig = {
	name: "app-session",
	password: process.env.SESSION_SECRET,
	cookie: {
		// Set APP_URL=https://... in production; plain-http access (first
		// login over http://<ip>:3000) would otherwise drop the cookie.
		secure: isSecureAppUrl(),
		sameSite: "lax",
		httpOnly: true,
	},
} as const;

/**
 * The sealed session cookie of the current request (server only). Not a
 * React hook despite TanStack's `useSession` name: safe in any branch.
 * `"browser"` writes a browser-session cookie (no Max-Age: gone when the
 * browser closes); the server-side session row still expires on its own.
 */
export function openAppSession(
	maxAge?: number | "browser",
): ReturnType<typeof sealedSession<SessionData>> {
	if (maxAge === "browser") {
		return sealedSession<SessionData>({ ...sessionConfig });
	}
	return sealedSession<SessionData>({
		...sessionConfig,
		maxAge: maxAge ?? SESSION_MAX_AGE,
	});
}
