import { defaultLocale } from "./config";
import {
	createCookieHeader,
	extractLocaleFromPath,
	parseLocaleCookie,
	shouldIgnorePath,
} from "./i18n.functions";

export function getLocaleFromRequest(request: Request) {
	const headers = request.headers;
	const url = new URL(request.url);
	const cookieLocale = parseLocaleCookie(headers.get("cookie"));

	if (shouldIgnorePath(url.pathname)) {
		return {
			locale: cookieLocale ?? defaultLocale,
		};
	}

	const locale =
		extractLocaleFromPath(url.pathname) ?? cookieLocale ?? defaultLocale;
	const shouldSetCookie = cookieLocale !== locale;

	return {
		locale,
		headers: shouldSetCookie
			? [
					{
						key: "Set-Cookie",
						value: createCookieHeader("locale", locale),
					},
				]
			: undefined,
	};
}
