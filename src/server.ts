import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createCookieHeader, i18nServerEntry, type Locale } from "#/libs/i18n";

/**
 * Server entry: canonicalizes locale URLs (e.g. strips the default `/en`
 * prefix) by redirecting before rendering, and syncs the locale cookie
 * with the locale in the URL.
 */
export default createServerEntry({
	async fetch(request) {
		const { redirect, setCookie } = i18nServerEntry(request);
		if (redirect) {
			return redirect;
		}

		const response = await handler.fetch(request);

		if (setCookie) {
			const cookieValue = createCookieHeader(setCookie.value as Locale);
			response.headers.append("Set-Cookie", cookieValue);
		}

		return response;
	},
});
