import { useLingui } from "@lingui/react";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { defaultLocale, LOCALE_COOKIE, type Locale } from "./config";
import {
	createCookieHeader,
	dynamicActivate,
	isValidLocale,
} from "./i18n.functions";
import { stripLocalePrefix } from "./paths";

export const useLocale = () => {
	const router = useRouter();
	const { i18n } = useLingui();
	const currentLocale = (i18n.locale || defaultLocale) as Locale;

	const switchLocale = useCallback(
		async (newLocale: Locale) => {
			if (newLocale === currentLocale) return;
			if (!isValidLocale(newLocale)) return;

			if (typeof cookieStore !== "undefined") {
				await cookieStore.set({
					name: LOCALE_COOKIE,
					value: newLocale,
					path: "/",
					expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
					sameSite: "lax",
				});
			} else {
				// biome-ignore lint/suspicious/noDocumentCookie: CookieStore API lacks full browser support
				document.cookie = createCookieHeader(LOCALE_COOKIE, newLocale);
			}

			await dynamicActivate(i18n, newLocale);
			document.documentElement.lang = newLocale;

			const basePath = stripLocalePrefix(window.location.pathname);
			const newPath =
				newLocale === defaultLocale
					? basePath
					: `/${newLocale}${basePath === "/" ? "" : basePath}`;

			await router.navigate({ to: newPath, replace: true });
			await router.invalidate();
		},
		[currentLocale, i18n, router],
	);

	return { currentLocale, switchLocale };
};
