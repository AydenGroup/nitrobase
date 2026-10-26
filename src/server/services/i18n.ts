import { type I18n, type Messages, setupI18n } from "@lingui/core";
import {
	cookieName,
	defaultLocale,
	type Locale,
	locales,
} from "#/libs/i18n.ts";

/**
 * Compiled catalogs (`bun run i18n:compile` → `src/locales/<code>.ts`) of
 * the manifest's locales, found by file name: adding a locale needs no
 * change here.
 */
const compiled = import.meta.glob<{ messages: Messages }>(
	"../../locales/*.ts",
	{ eager: true },
);

/** Catalogs of `codes` among compiled modules keyed by `<dir>/<code>.ts`. */
export function catalogsFor(
	codes: readonly string[],
	modules: Record<string, { messages: Messages }>,
): Record<string, Messages> {
	const byCode = new Map(
		Object.entries(modules).map(([path, module]) => [
			path.replace(/^.*\/([\w-]+)\.ts$/, "$1"),
			module.messages,
		]),
	);
	return Object.fromEntries(
		codes.flatMap((code) => {
			const messages = byCode.get(code);
			return messages ? [[code, messages]] : [];
		}),
	);
}

const catalogs = catalogsFor(
	locales.map((locale) => locale.code),
	compiled,
);

const cache = new Map<Locale, I18n>();

/** True when `value` is a supported locale code. */
export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && Object.hasOwn(catalogs, value);
}

/**
 * Lingui instance for text rendered on the server outside server-function
 * middleware (WebSocket banners, notifications). Unknown locales fall back
 * to the default. Instances are cached per locale.
 */
export function serverI18n(locale?: string | null): I18n {
	const code = isLocale(locale) ? locale : defaultLocale;
	const cached = cache.get(code);
	if (cached) return cached;
	const i18n = setupI18n({ messages: catalogs });
	i18n.activate(code);
	cache.set(code, i18n);
	return i18n;
}

/** Locale named by the locale cookie of a raw `Cookie` header, if any. */
export function localeFromCookieHeader(
	cookieHeader: string,
): Locale | undefined {
	const value = cookieHeader
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${cookieName}=`))
		?.slice(cookieName.length + 1);
	if (!value) return undefined;
	try {
		const decoded = decodeURIComponent(value);
		return isLocale(decoded) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

/**
 * First supported locale of an `Accept-Language` header (by q-value, exact
 * tag or its base language), if any. For API clients without the cookie.
 */
export function localeFromAcceptLanguage(
	header: string | null | undefined,
): Locale | undefined {
	const ranked = (header ?? "")
		.split(",")
		.map((part, index) => {
			const [tag = "", ...params] = part.trim().split(";");
			const q = params
				.map((param) => param.trim())
				.find((param) => param.startsWith("q="));
			return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1, index };
		})
		.filter((item) => item.tag && item.q > 0)
		.sort((a, b) => b.q - a.q || a.index - b.index);
	for (const { tag } of ranked) {
		const base = tag.split("-")[0];
		for (const candidate of [tag, base]) {
			if (isLocale(candidate)) return candidate;
		}
	}
	return undefined;
}
