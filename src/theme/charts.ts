import { surfaces } from "./surfaces";

/** Chart colors of one color scheme. */
export interface ChartPaletteTokens {
	/** Categorical series in fixed order (a series keeps its slot, never cycled). */
	series: readonly string[];
	/** Folded "other" series and free/idle filler. */
	other: string;
	/** Horizontal grid lines: a hairline, barely there. */
	grid: string;
	/** Axis and tick text. */
	axis: string;
}

/**
 * Quiet categorical palette (green, blue, pink first, as in the Supabase
 * dashboard). Dark values are light and soft; light values are deeper so they
 * hold 3:1 on a white card. `charts.test.ts` checks contrast and that the
 * series stay apart under color-vision deficiencies (strictly for the first
 * three, which most charts use; the legend names the rest).
 */
export const chartPalette: {
	dark: ChartPaletteTokens;
	light: ChartPaletteTokens;
} = {
	dark: {
		series: ["#3fcf8e", "#3b82f6", "#f65cb6", "#f2af48", "#c4b5fd", "#fb923c"],
		other: "#6b6d6d",
		grid: surfaces.dark.border,
		axis: surfaces.dark.text3,
	},
	light: {
		series: ["#15803d", "#3b82f6", "#ec4899", "#b45309", "#6d28d9", "#475569"],
		other: "#8b8d8d",
		grid: surfaces.light.border,
		axis: surfaces.light.text3,
	},
};
