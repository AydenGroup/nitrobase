import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { localeParams } from "#/libs/i18n.ts";
import { openAppSession } from "#/utils/session.ts";
import { resolveSession } from "./sessions.server";

/**
 * Login page in the locale of the page that made the call (its Referer).
 * An absolute href: a route path (`to`) in a server function's redirect is
 * resolved against the server function's own URL (`/_serverFn/login`).
 */
function loginHref(): string {
	const referer = getRequestHeader("referer");
	let first = "";
	try {
		first = referer ? (new URL(referer).pathname.split("/")[1] ?? "") : "";
	} catch {
		// Malformed Referer: the default locale.
	}
	const { locale } = localeParams(first);
	return locale ? `/${locale}/login` : "/login";
}

/**
 * Signed-in user from the session cookie. The cookie only carries the
 * session id: a revoked or expired session row (or a deleted user) is
 * logged out here on the next request.
 */
export const authMiddleware = createMiddleware().server(async ({ next }) => {
	const session = await openAppSession();
	const resolved = await resolveSession(session.data);
	if (!resolved) {
		// A redirect thrown from a server function is followed by the client
		// router, so an expired session lands on the login page.
		throw redirect({ href: loginHref() });
	}

	return next({
		context: {
			user: {
				...session.data,
				userId: resolved.userId,
				email: resolved.email,
				sessionId: resolved.sessionId,
			},
		},
	});
});
