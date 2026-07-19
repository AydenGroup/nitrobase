import type { I18n } from "@lingui/core";
import {
	defaultLocale,
	ignoredPathsRegex,
	LOCALE_COOKIE,
	type Locale,
	supportedLocales,
} from "./config";

export const isValidLocale = (locale: string | undefined): locale is Locale => {
	return supportedLocales.includes(locale as Locale);
};

export const shouldIgnorePath = (pathname: string): boolean => {
	return ignoredPathsRegex.test(pathname);
};

export const extractLocaleFromPath = (pathname: string): Locale | null => {
	const match = /^\/([a-z]{2})(?:\/|$)/.exec(pathname);
	const locale = match?.[1];
	return locale && isValidLocale(locale) ? (locale as Locale) : null;
};

export const parseLocaleCookie = (
	cookieHeader: string | null,
): Locale | null => {
	if (!cookieHeader) return null;
	const match = cookieHeader.match(
		new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`),
	);
	const rawValue = match?.[1];
	if (!rawValue) return null;
	const val = decodeURIComponent(rawValue) as Locale;
	return isValidLocale(val) ? val : null;
};

export function createCookieHeader(name: string, value: string): string {
	return `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export async function dynamicActivate(i18n: I18n, locale: Locale) {
	if (i18n.locale === locale) return;

	try {
		const { messages } = await import(`../locales/${locale}.json?lingui`);
		i18n.loadAndActivate({ locale, messages });
	} catch {
		const { messages } = await import(
			`../locales/${defaultLocale}.json?lingui`
		);
		i18n.loadAndActivate({ locale: defaultLocale, messages });
	}
}
