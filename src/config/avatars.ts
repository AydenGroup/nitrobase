import { identiconSvg } from "#/libs/identicon.ts";

/**
 * Avatar styles rendered by Nitrobase itself (`/api/avatars/<style>/<seed>`),
 * so showing an avatar never contacts a third-party service. Add a style =
 * one entry here. An empty `avatarUrl` shows the user's initials instead.
 */
export interface AvatarStyle {
	/** SVG document for `seed` (pure: same seed, same picture). */
	render: (seed: string) => string;
	/** Seeds offered in the profile picker. */
	presets: readonly string[];
}

export const avatarStyles = {
	identicon: {
		render: identiconSvg,
		presets: ["Dax", "Izumi", "Celia", "Edgar", "Boris", "Erik", "Amara"],
	},
} as const satisfies Record<string, AvatarStyle>;

export type AvatarStyleId = keyof typeof avatarStyles;

/** Route prefix serving generated avatars. */
const AVATAR_ROUTE = "/api/avatars";
const SEED = /^[A-Za-z0-9_-]{1,32}$/;

export function isAvatarStyle(value: string): value is AvatarStyleId {
	return Object.hasOwn(avatarStyles, value);
}

export function isAvatarSeed(value: string): boolean {
	return SEED.test(value);
}

/** Same-origin URL of a generated avatar. */
export function avatarPath(style: AvatarStyleId, seed: string): string {
	return `${AVATAR_ROUTE}/${style}/${seed}`;
}

/** Every preset of every style, as picker options. */
export function avatarPresets(): { style: AvatarStyleId; url: string }[] {
	return (Object.keys(avatarStyles) as AvatarStyleId[]).flatMap((style) =>
		avatarStyles[style].presets.map((seed) => ({
			style,
			url: avatarPath(style, seed),
		})),
	);
}

/**
 * Accepted `avatarUrl` values: empty (initials), a generated avatar path on
 * this origin, or an https URL the user chose. Anything else (http, data:,
 * javascript:, protocol-relative, other paths) is refused.
 */
export function isAllowedAvatarUrl(value: string): boolean {
	if (value === "") return true;
	if (value.startsWith("/")) {
		const [style, seed, ...rest] = value
			.slice(AVATAR_ROUTE.length + 1)
			.split("/");
		return (
			value.startsWith(`${AVATAR_ROUTE}/`) &&
			rest.length === 0 &&
			isAvatarStyle(style) &&
			isAvatarSeed(seed ?? "")
		);
	}
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}
