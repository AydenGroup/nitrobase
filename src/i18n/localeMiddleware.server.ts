import { defaultLocale, LOCALE_COOKIE } from "./config";
import {
	extractLocaleFromPath,
	parseLocaleCookie,
	shouldIgnorePath,
} from "./i18n.functions";

export interface LocaleMiddlewareResult {
	redirect?: Response;
	setCookie?: { name: string; value: string };
}

export function handleLocaleMiddleware(
	request: Request,
): LocaleMiddlewareResult {
	const url = new URL(request.url);
	const { pathname } = url;

	if (shouldIgnorePath(pathname)) return {};

	if (
		pathname.startsWith(`/${defaultLocale}/`) ||
		pathname === `/${defaultLocale}`
	) {
		url.pathname = pathname.replace(`/${defaultLocale}`, "") || "/";
		return { redirect: Response.redirect(url.toString(), 301) };
	}

	const urlLocale = extractLocaleFromPath(pathname);

	if (urlLocale) {
		const stripped = pathname.replace(`/${urlLocale}`, "") || "/";
		if (shouldIgnorePath(stripped)) {
			url.pathname = stripped;
			return { redirect: Response.redirect(url.toString(), 301) };
		}

		const cookieLocale = parseLocaleCookie(request.headers.get("cookie"));
		if (urlLocale !== cookieLocale) {
			return { setCookie: { name: LOCALE_COOKIE, value: urlLocale } };
		}
	}

	return {};
}
