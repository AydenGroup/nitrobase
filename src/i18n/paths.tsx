import { type FileRouteTypes, Link } from "@tanstack/react-router";
import { supportedLocales } from "./config";

export type LocalizedFullPaths = Extract<
	FileRouteTypes["to"],
	`/{-$locale}${string}`
>;

export type StripLocalePrefix<T extends string> = T extends "/{-$locale}"
	? "/"
	: T extends `/{-$locale}${infer Rest}`
		? Rest
		: never;

export type LocalizedTo = StripLocalePrefix<LocalizedFullPaths>;

export function stripLocalePrefix(pathname: string): string {
	for (const locale of supportedLocales) {
		if (pathname === `/${locale}`) return "/";
		if (pathname.startsWith(`/${locale}/`)) {
			return pathname.slice(locale.length + 1) || "/";
		}
	}

	return pathname;
}

export function localizePath(to: LocalizedTo): LocalizedFullPaths {
	return (
		to === "/" ? "/{-$locale}" : `/{-$locale}${to}`
	) as LocalizedFullPaths;
}

type LocalizedLinkProps<TTo extends LocalizedTo> = React.ComponentProps<
	typeof Link
> & {
	to: TTo;
};

export function LocalizedLink<TTo extends LocalizedTo>({
	to,
	...props
}: LocalizedLinkProps<TTo>) {
	return <Link to={localizePath(to)} {...props} />;
}
