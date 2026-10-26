import type { MantineBreakpoint, MantineColor } from "@mantine/core";
import { surfaces } from "./surfaces";

/** Semantic status tones used by every status badge/dot. */
export type StatusTone =
	| "success"
	| "warning"
	| "danger"
	| "info"
	| "neutral"
	| "progress";

/** Tone -> Mantine palette color. Change here to restyle all statuses. */
export const toneColors: Record<StatusTone, MantineColor> = {
	success: "green",
	warning: "yellow",
	danger: "red",
	info: "blue",
	neutral: "gray",
	progress: "brand",
};

/** Accent color name used across the theme. */
export const ACCENT = "brand";

/** Signed-in shell: sidebar width and the mobile top bar (desktop uses the panel bar, see styles.css). */
export const appFrame = {
	navbarWidth: 240,
	mobileHeaderHeight: 48,
} as const;

/** Text and heading font (self-hosted Inter, see fonts.css). */
export const FONT_SANS =
	"'Inter Variable', system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Code, ids, status badges and group labels: the system monospace stack. */
export const FONT_MONO =
	"ui-monospace, SFMono-Regular, 'Cascadia Mono', Menlo, Consolas, monospace";

/**
 * Categorical chart colors in fixed order (series keep their slot; never
 * cycled): CSS variables set per color scheme from `chartPalette` (charts.ts).
 * More series than slots fold into "Other" (`chartOtherColor`).
 */
export const chartSeriesColors: string[] = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
	"var(--chart-6)",
];
export const chartOtherColor = "var(--chart-other)";

/** xterm.js look of every terminal (host and container shells). */
export const terminalTheme = {
	fontFamily: FONT_MONO,
	fontSize: 13,
	lineHeight: 1.25,
	fontWeight: "500",
	/** Surface around the xterm canvas. */
	surface: {
		background: surfaces.dark.canvas,
		borderColor: surfaces.dark.border,
		boxShadow: `inset 0 0 0 1px ${surfaces.dark.card}, 0 12px 32px #00000040`,
	},
	colors: {
		background: surfaces.dark.canvas,
		foreground: "#e3e3e3",
		cursor: "#f1f3f4",
		cursorAccent: surfaces.dark.canvas,
		selectionBackground: "#ffffff22",
		black: surfaces.dark.card,
		red: "#f28b82",
		green: "#81c995",
		yellow: "#fdd663",
		blue: "#8ab4f8",
		magenta: "#c58af9",
		cyan: "#78d9ec",
		white: "#f8f9fa",
		brightBlack: "#5f6368",
		brightRed: "#f6aea9",
		brightGreen: "#a8dab5",
		brightYellow: "#fde293",
		brightBlue: "#aecbfa",
		brightMagenta: "#d7aefb",
		brightCyan: "#a1e4f2",
		brightWhite: "#ffffff",
	},
	/** ANSI SGR codes for client-side status lines. */
	notice: { info: "33", error: "31" },
} as const;

/** Decorative hero panel of the sign-in/registration pages. */
export const authHero = {
	overlayColor: surfaces.dark.canvas,
	overlayOpacity: 0.65,
} as const;

/**
 * Severity → color of chat notifications (Discord embeds, Slack
 * attachments), 24-bit RGB: the Mantine shades the UI uses for the tones.
 */
export const notificationSeverityColors = {
	/** blue.6 */
	info: 0x228be6,
	/** yellow.8 */
	warning: 0xf59f00,
	/** red.8 */
	error: 0xe03131,
	/** pink.8 */
	critical: 0xc2255c,
} as const;

/**
 * Detail pages (app, database, server) with many tabs: a vertical tab
 * column from `breakpoint` up (sticky under the header), a select below.
 */
export const resourceTabsLayout = {
	listWidth: 200,
	breakpoint: "md",
	/** Tab icon size (px). */
	iconSize: 16,
} as const satisfies {
	listWidth: number;
	breakpoint: MantineBreakpoint;
	iconSize: number;
};
