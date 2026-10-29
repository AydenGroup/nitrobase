import {
	createLinguiStart,
	type LocaleDefinition,
} from "@jimmyphong/lingui-start";
import type { I18n } from "@lingui/core";
import { LOCALE_COOKIE_MAX_AGE_SECONDS } from "#/config/shared.ts";
import { internalError } from "#/utils/error.ts";
import { formatLanguageName } from "./intl.ts";
import { localeManifest } from "./locale-manifest.ts";

/** First path segments that never carry a locale prefix (API endpoints). */
export const ignoredPaths = ["api", "rpc", "webhook"];
/** Cookie remembering the last locale used. */
export const cookieName = "locale";

export type Locale = string;

/** The source locale of the manifest: message ids are its text. */
export const defaultLocale: Locale = localeManifest.sourceLocale;

export interface AppLocale extends LocaleDefinition {
	dir: "ltr" | "rtl";
}

/**
 * Supported locales, from `src/locales/locales.json` (see
 * `locale-manifest.ts`). Names come from `Intl.DisplayNames`: `name` in the
 * source language, `nativeName` in the language itself (the menu label).
 */
export const locales: readonly AppLocale[] = localeManifest.entries.map(
	(entry) => ({
		code: entry.code,
		name: formatLanguageName(defaultLocale, entry.code),
		nativeName: formatLanguageName(entry.code, entry.code),
		dir: entry.dir ?? "ltr",
	}),
);

/** Writing direction of `locale` (`<html dir>`). */
export function localeDirection(locale: string): "ltr" | "rtl" {
	return locales.find((item) => item.code === locale)?.dir ?? "ltr";
}

/**
 * Catalogs `src/locales/<code>.json`, compiled on import by the Lingui Vite
 * plugin (`?lingui`). The manifest and `<code>.glossary.json` files live in
 * the same folder and are not catalogs.
 */
const catalogLoaders = import.meta.glob<Record<string, string>>(
	["../locales/*.json", "!../locales/locales.json", "!../locales/*.*.json"],
	{ query: "?lingui", import: "messages" },
);

/**
 * Lingui integration for TanStack Start: the locale comes from the URL
 * prefix or the cookie (else the default), and catalogs load lazily.
 */
export const i18n = createLinguiStart({
	locales,
	defaultLocale: defaultLocale,
	cookieName: cookieName,
	cookieMaxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
	ignoredPaths: ignoredPaths,
	loadMessages: async (locale: string) => {
		const load = catalogLoaders[`../locales/${locale}.json`];
		if (!load) throw internalError(`No catalog for locale "${locale}"`);
		return load();
	},
});

export const {
	setupI18n,
	i18nServerEntry,
	i18nMiddleware,
	useLocale,
	LocalizedLink,
	localizePath,
	isValidLocale,
	routerWithI18n,
	createCookieHeader,
} = i18n;

/** Path without the optional `/<locale>` prefix (for active-nav matching). */
export function stripLocale(pathname: string): string {
	const [, first, ...rest] = pathname.split("/");
	if (locales.some((locale) => locale.code === first)) {
		return `/${rest.join("/")}`.replace(/\/$/, "") || "/";
	}
	return pathname.replace(/\/$/, "") || "/";
}

/**
 * `{-$locale}` param for a link to an absolute page in `locale` (the active
 * i18n locale). LocalizedLink reuses the current route's param, which on a
 * 404 can be any unknown first segment; this always yields a supported
 * locale, and none for the default one.
 */
export function localeParams(locale: string): { locale: Locale | undefined } {
	const known = locales.find((item) => item.code === locale)?.code;
	return { locale: known && known !== defaultLocale ? known : undefined };
}

/**
 * Real path of an absolute page in `locale` (`/vi/invite/x`, no prefix for the
 * default locale), for links shown or sent outside the router. `localizePath`
 * is not for this: it returns a route pattern (`/{-$locale}/...`) for the
 * router's `to`.
 */
export function localizedHref(path: string, locale: string): string {
	const { locale: prefix } = localeParams(locale);
	return prefix ? `/${prefix}${path}` : path;
}

/**
 * Translate a text that comes from a template.toml (name, description,
 * notes, limitation, security reason, variable label/description/group,
 * port label/description). The server sends these in English; their ids
 * are put in the catalogs by the template extractor
 * (`scripts/lingui/template-extractor.ts`, registered in lingui.config.ts).
 *
 * This is the ONLY sanctioned `i18n._(variable)` in the code base: every
 * other call takes a literal or a `msg` descriptor. Never pass user-written
 * content (custom compose routes, app or user names) through it; an
 * unknown id falls back to the English text.
 */
export function translateTemplateText(i18n: I18n, text: string): string;
export function translateTemplateText(
	i18n: I18n,
	text: string | null | undefined,
): string | undefined;
export function translateTemplateText(
	i18n: I18n,
	text: string | null | undefined,
): string | undefined {
	return text ? i18n._(text) : undefined;
}
