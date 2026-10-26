import {
	ACCENT_ATTRIBUTE,
	ACCENT_STORAGE_KEY,
	ACCENTS,
	type AccentTone,
	DEFAULT_ACCENT,
} from "./accents";

/** Share of the scheme's lift color (white in dark, black in light) mixed into a hovered fill. */
const HOVER_MIX_PERCENT = 12;
/** Share of the accent border color kept in the soft focus ring. */
const SOFT_PERCENT = 20;

const DARK = '[data-mantine-color-scheme="dark"]';
const MIX = { dark: "#ffffff", light: "#000000" } as const;

const tone = (t: AccentTone, mix: string): string =>
	`--accent-fill:${t.fill};--accent-on-fill:${t.onFill};--accent-text:${t.text};--accent-border:${t.border};--accent-mix:${mix};`;

/**
 * CSS variables of the accent color, selected by `html[data-accent]` and the
 * Mantine color scheme attribute. Every rule is scoped to `:root`, so portals
 * (menus, modals, notifications) get the colors as well. The default accent
 * comes first and applies without any attribute.
 */
export const buildAccentCss = (): string => {
	const fallback = ACCENTS.find((a) => a.id === DEFAULT_ACCENT) ?? ACCENTS[0];
	const derived =
		`--accent-fill-hover:color-mix(in srgb, var(--accent-fill) ${100 - HOVER_MIX_PERCENT}%, var(--accent-mix));` +
		`--accent-soft:color-mix(in srgb, var(--accent-border) ${SOFT_PERCENT}%, transparent);`;
	const blocks = [
		`:root{${tone(fallback.light, MIX.light)}${derived}}`,
		`:root${DARK}{${tone(fallback.dark, MIX.dark)}}`,
	];
	for (const accent of ACCENTS) {
		const selector = `:root[${ACCENT_ATTRIBUTE}="${accent.id}"]`;
		blocks.push(`${selector}{${tone(accent.light, MIX.light)}}`);
		blocks.push(`${selector}${DARK}{${tone(accent.dark, MIX.dark)}}`);
	}
	return blocks.join("\n");
};

export const ACCENT_CSS = buildAccentCss();

/**
 * Inline `<head>` script: sets `data-accent` from localStorage before first
 * paint, so a stored accent never flashes the default.
 * Storage that throws (private window, blocked data) or holds an unknown
 * value leaves the default.
 */
export const ACCENT_BOOT_SCRIPT = `try{var v=localStorage.getItem(${JSON.stringify(ACCENT_STORAGE_KEY)});if(${JSON.stringify(ACCENTS.map((a) => a.id))}.indexOf(v)>-1){document.documentElement.setAttribute(${JSON.stringify(ACCENT_ATTRIBUTE)},v)}}catch(e){}`;
