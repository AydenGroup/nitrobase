export const defaultLocale = "en" as const;
export const LOCALE_COOKIE = "locale";
export const ignoredPathsRegex = /^\/(?:api|rpc|webhook|dashboard)(?:\/|$)/;

export const locales = [
	{
		code: "en",
		name: "English",
		nativeName: "English",
		regionCode: "us",
	},
	{
		code: "vi",
		name: "Vietnamese",
		nativeName: "Tiếng Việt",
		regionCode: "vn",
	},
] as const;

export type Language = (typeof locales)[number];
export type Locale = Language["code"];

export const supportedLocales: ReadonlyArray<Locale> = locales.map(
	(locale) => locale.code,
);
