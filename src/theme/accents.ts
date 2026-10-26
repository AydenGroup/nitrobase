import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { resourceName } from "#/config/identifiers.ts";

export type AccentId =
	| "mono"
	| "emerald"
	| "blue"
	| "violet"
	| "orange"
	| "pink";

/** Colors of one accent in one color scheme (`#rrggbb`). */
export interface AccentTone {
	/** Filled button, switch, progress. */
	fill: string;
	/** Label and icon on `fill`. */
	onFill: string;
	/** Links, selected icons. */
	text: string;
	/** Focus ring and selected tab marker. */
	border: string;
}

export interface AccentDef {
	id: AccentId;
	label: MessageDescriptor;
	/** Color of the picker dot. */
	swatch: string;
	dark: AccentTone;
	light: AccentTone;
}

/**
 * User-selectable accent colors. No red or yellow: those carry the error and
 * warning meaning. Values are checked for contrast by `accents.test.ts`.
 */
export const ACCENTS: readonly AccentDef[] = [
	{
		id: "mono",
		label: msg`Monochrome`,
		swatch: "#ededed",
		dark: {
			fill: "#ededed",
			onFill: "#141414",
			text: "#ededed",
			border: "#ededed",
		},
		light: {
			fill: "#171717",
			onFill: "#ffffff",
			text: "#171717",
			border: "#171717",
		},
	},
	{
		id: "emerald",
		label: msg`Emerald`,
		swatch: "#3ecf8e",
		dark: {
			fill: "#006239",
			onFill: "#ededed",
			text: "#3ecf8e",
			border: "#3ecf8e",
		},
		light: {
			fill: "#00704a",
			onFill: "#ffffff",
			text: "#047857",
			border: "#059669",
		},
	},
	{
		id: "blue",
		label: msg`Blue`,
		swatch: "#3b82f6",
		dark: {
			fill: "#2563eb",
			onFill: "#ffffff",
			text: "#6ea8fe",
			border: "#3b82f6",
		},
		light: {
			fill: "#2563eb",
			onFill: "#ffffff",
			text: "#1d4ed8",
			border: "#3b82f6",
		},
	},
	{
		id: "violet",
		label: msg`Violet`,
		swatch: "#8b5cf6",
		dark: {
			fill: "#6d28d9",
			onFill: "#ffffff",
			text: "#a78bfa",
			border: "#8b5cf6",
		},
		light: {
			fill: "#6d28d9",
			onFill: "#ffffff",
			text: "#6d28d9",
			border: "#8b5cf6",
		},
	},
	{
		id: "orange",
		label: msg`Orange`,
		swatch: "#f97316",
		dark: {
			fill: "#c2410c",
			onFill: "#ffffff",
			text: "#fb923c",
			border: "#f97316",
		},
		light: {
			fill: "#c2410c",
			onFill: "#ffffff",
			text: "#c2410c",
			border: "#ea580c",
		},
	},
	{
		id: "pink",
		label: msg`Pink`,
		swatch: "#ec4899",
		dark: {
			fill: "#be185d",
			onFill: "#ffffff",
			text: "#f472b6",
			border: "#ec4899",
		},
		light: {
			fill: "#be185d",
			onFill: "#ffffff",
			text: "#be185d",
			border: "#ec4899",
		},
	},
];

export const DEFAULT_ACCENT: AccentId = "mono";

/** localStorage key the chosen accent is written to (`<prefix>-accent`). */
export const ACCENT_STORAGE_KEY = resourceName("accent");

/** Attribute on `<html>` that selects the accent's CSS variables. */
export const ACCENT_ATTRIBUTE = "data-accent";

export const isAccentId = (value: unknown): value is AccentId =>
	typeof value === "string" && ACCENTS.some((accent) => accent.id === value);

/** A stored or received value to an accent id; anything unknown is the default. */
export const parseAccent = (raw: string | null | undefined): AccentId =>
	isAccentId(raw) ? raw : DEFAULT_ACCENT;
