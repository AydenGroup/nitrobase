import { locales } from "#/libs/i18n.ts";

/**
 * The sign-in page as a real URL for the current page: same locale prefix
 * (`/vi/...` → `/vi/login`), and a `redirect` back to where the user was.
 */
export function loginHref(
	location: Pick<Location, "pathname" | "search">,
): string {
	const [, first] = location.pathname.split("/");
	const prefix = locales.some((locale) => locale.code === first)
		? `/${first}`
		: "";
	const back = `${location.pathname}${location.search}`;
	return `${prefix}/login?${new URLSearchParams({ redirect: back, reason: "session_ended" })}`;
}

/**
 * The server closes live streams with a `session_ended` event when the
 * session is revoked or expires: stop the EventSource (no reconnect loop)
 * and go to the sign-in page.
 */
export function closeOnSessionEnded(es: EventSource): void {
	es.addEventListener("session_ended", (event) => {
		es.close();
		let reason: string | undefined;
		try {
			reason = JSON.parse((event as MessageEvent<string>).data)?.reason;
		} catch {
			// older payload without a reason: treat as signed out
		}
		// Access changed in the team (removed, role lowered): the session is
		// still valid, so reload with the new permissions instead.
		if (reason === "forbidden") window.location.reload();
		else window.location.assign(loginHref(window.location));
	});
}
