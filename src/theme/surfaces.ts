import type { MantineColorsTuple } from "@mantine/core";

/**
 * Surface, border and text tones of one color scheme. Frame (canvas) sinks,
 * content (panel, card) floats; layers differ by a few lightness steps.
 */
export interface SurfaceTokens {
	/** Body and sidebar. */
	canvas: string;
	/** Nested content area. */
	panel: string;
	/** Card, Paper, Modal, Drawer. */
	card: string;
	/** Secondary buttons, workspace switcher. */
	control: string;
	/** Text inputs, segmented control track. */
	input: string;
	hover: string;
	/** Selected nav item, tab, segment. */
	active: string;
	border: string;
	borderStrong: string;
	/** Hairline around the panel and under its top bar (alpha). */
	borderPanel: string;
	text1: string;
	text2: string;
	text3: string;
}

export const surfaces: { dark: SurfaceTokens; light: SurfaceTokens } = {
	dark: {
		canvas: "#111212",
		panel: "#151616",
		card: "#191a1a",
		control: "#1d1e1e",
		input: "#121313",
		hover: "#1f2020",
		active: "#222323",
		border: "#242525",
		borderStrong: "#303131",
		borderPanel: "rgba(255,255,255,0.06)",
		text1: "#ededed",
		text2: "#b9baba",
		text3: "#8f9191",
	},
	light: {
		canvas: "#fafafa",
		panel: "#ffffff",
		card: "#ffffff",
		control: "#f4f4f5",
		input: "#ffffff",
		hover: "#f4f4f5",
		active: "#ececee",
		border: "#e6e6e6",
		borderStrong: "#d4d4d8",
		borderPanel: "rgba(0,0,0,0.06)",
		text1: "#171717",
		text2: "#525252",
		text3: "#6b6b6b",
	},
};

/** Mid step between text3 and borderStrong in the Mantine `dark` tuple. */
const DARK_MID = "#6b6d6d";

/** Mantine `dark` tuple (0 = text ... 9 = canvas) built from the dark surfaces. */
export const darkScale = (s: SurfaceTokens): MantineColorsTuple => [
	s.text1,
	s.text2,
	s.text3,
	DARK_MID,
	s.borderStrong,
	s.border,
	s.active,
	s.hover,
	s.card,
	s.canvas,
];
