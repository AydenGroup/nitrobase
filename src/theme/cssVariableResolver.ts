import type { CSSVariablesResolver } from "@mantine/core";
import { type ChartPaletteTokens, chartPalette } from "./charts";
import { type SurfaceTokens, surfaces } from "./surfaces";

/** Soft shadow of floating surfaces (menus, popovers, modals, toasts) per scheme. */
const POP_SHADOW = {
	dark: "0 16px 40px rgb(0 0 0 / 50%)",
	light: "0 12px 32px rgb(0 0 0 / 12%)",
} as const;

/** `--sb-*` variables and the Mantine defaults that follow the same tokens. */
const schemeVariables = (
	s: SurfaceTokens,
	shadow: string,
	chart: ChartPaletteTokens,
): Record<string, string> => ({
	"--sb-canvas": s.canvas,
	"--sb-panel": s.panel,
	"--sb-card": s.card,
	"--sb-control": s.control,
	"--sb-input": s.input,
	"--sb-hover": s.hover,
	"--sb-active": s.active,
	"--sb-border": s.border,
	"--sb-border-strong": s.borderStrong,
	"--sb-border-panel": s.borderPanel,
	"--sb-text-1": s.text1,
	"--sb-text-2": s.text2,
	"--sb-text-3": s.text3,
	"--sb-shadow-pop": shadow,
	...Object.fromEntries(
		chart.series.map((color, index) => [`--chart-${index + 1}`, color]),
	),
	"--chart-other": chart.other,
	"--chart-grid": chart.grid,
	"--chart-axis": chart.axis,
	"--mantine-color-body": s.canvas,
	"--mantine-color-default": s.card,
	"--mantine-color-default-color": s.text1,
	"--mantine-color-default-border": s.border,
	"--mantine-color-default-hover": s.hover,
	"--mantine-color-text": s.text1,
	"--mantine-color-dimmed": s.text3,
	"--mantine-color-placeholder": s.text3,
	// Mantine sets the primary-color and link variables per scheme, so the
	// accent mapping lives here too (a global override would lose to it).
	"--mantine-primary-color-filled": "var(--accent-fill)",
	"--mantine-primary-color-filled-hover": "var(--accent-fill-hover)",
	"--mantine-primary-color-contrast": "var(--accent-on-fill)",
	"--mantine-primary-color-light-color": "var(--accent-text)",
	"--mantine-color-anchor": "var(--accent-text)",
	"--mantine-color-brand-filled": "var(--accent-fill)",
	"--mantine-color-brand-filled-hover": "var(--accent-fill-hover)",
	"--mantine-color-brand-light": "var(--accent-soft)",
	"--mantine-color-brand-light-color": "var(--accent-text)",
	"--mantine-color-brand-outline": "var(--accent-border)",
});

/**
 * Overrides Mantine CSS variables per color scheme from the surface tokens
 * and points the primary color at the user's accent variables.
 */
export const mantineCssVariableResolver: CSSVariablesResolver = () => ({
	variables: {
		"--mantine-ease-smooth": "cubic-bezier(0.16, 1, 0.3, 1)",
	},
	light: schemeVariables(surfaces.light, POP_SHADOW.light, chartPalette.light),
	dark: schemeVariables(surfaces.dark, POP_SHADOW.dark, chartPalette.dark),
});
