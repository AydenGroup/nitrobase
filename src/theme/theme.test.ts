import { DEFAULT_THEME, mergeMantineTheme, rem } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { chartPalette } from "./charts";
import { mantineCssVariableResolver } from "./cssVariableResolver";
import { mantineTheme } from "./index";
import { statusColors } from "./status-colors";
import { surfaces } from "./surfaces";
import {
	authHero,
	chartOtherColor,
	chartSeriesColors,
	FONT_MONO,
	terminalTheme,
} from "./tokens";

const theme = mergeMantineTheme(DEFAULT_THEME, mantineTheme);

describe("mantineCssVariableResolver", () => {
	const vars = mantineCssVariableResolver(theme);

	it("exposes the surface tokens per scheme as --sb-* variables", () => {
		expect(vars.dark["--sb-canvas"]).toBe(surfaces.dark.canvas);
		expect(vars.light["--sb-canvas"]).toBe(surfaces.light.canvas);
		expect(vars.dark["--sb-text-3"]).toBe(surfaces.dark.text3);
		expect(vars.light["--sb-border-strong"]).toBe(surfaces.light.borderStrong);
		expect(vars.dark["--sb-border-panel"]).toBe(surfaces.dark.borderPanel);
	});

	it.each([
		"light",
		"dark",
	] as const)("points the primary color and links at the accent variables in the %s scheme", (scheme) => {
		// Mantine sets these per scheme, so a global override would lose to it.
		expect(vars[scheme]["--mantine-color-brand-filled"]).toBe(
			"var(--accent-fill)",
		);
		expect(vars[scheme]["--mantine-primary-color-filled"]).toBe(
			"var(--accent-fill)",
		);
		expect(vars[scheme]["--mantine-primary-color-contrast"]).toBe(
			"var(--accent-on-fill)",
		);
		expect(vars[scheme]["--mantine-color-anchor"]).toBe("var(--accent-text)");
	});

	it("points the Mantine defaults at the same tokens", () => {
		expect(vars.dark["--mantine-color-body"]).toBe(surfaces.dark.canvas);
		expect(vars.dark["--mantine-color-default"]).toBe(surfaces.dark.card);
		expect(vars.dark["--mantine-color-default-border"]).toBe(
			surfaces.dark.border,
		);
		expect(vars.dark["--mantine-color-dimmed"]).toBe(surfaces.dark.text3);
		expect(vars.light["--mantine-color-text"]).toBe(surfaces.light.text1);
	});
});

describe("theme scale", () => {
	const px = (value: number) => rem(`${value}px`);

	it("uses the compact type scale (14px body, 13px controls)", () => {
		const sizes = Object.fromEntries(
			Object.entries(theme.fontSizes).map(([k, v]) => [k, v]),
		);
		expect(sizes).toMatchObject({
			xs: px(12),
			sm: px(13),
			md: px(14),
			lg: px(16),
			xl: px(18),
			"2xl": px(20),
			"3xl": px(24),
			"4xl": px(30),
			"5xl": px(36),
		});
	});

	it("uses radii 4/6/8/10/14 with md as the default", () => {
		expect(theme.defaultRadius).toBe("md");
		expect(theme.radius).toMatchObject({
			xs: px(4),
			sm: px(6),
			md: px(8),
			lg: px(10),
			xl: px(14),
		});
	});

	it("uses spacing 4/6/8/12/16/20/24/32/40", () => {
		expect(theme.spacing).toMatchObject({
			"3xs": px(4),
			"2xs": px(6),
			xs: px(8),
			sm: px(12),
			md: px(16),
			lg: px(20),
			xl: px(24),
			"2xl": px(32),
			"3xl": px(40),
		});
	});

	it("sets Inter for text and the system mono stack for code", () => {
		expect(theme.fontFamily.startsWith("'Inter Variable'")).toBe(true);
		expect(theme.fontFamilyMonospace).toBe(FONT_MONO);
		expect(theme.headings.fontFamily).toBe(theme.fontFamily);
	});

	it("makes page titles 20px / 600", () => {
		expect(theme.headings.sizes.h2.fontSize).toBe(px(20));
		expect(theme.headings.fontWeight).toBe("600");
	});

	it("keeps components flat: shadows come from CSS tokens, not Mantine shadows", () => {
		expect(Object.values(theme.shadows).every((s) => s === "none")).toBe(true);
	});

	it("styles Badge as mono uppercase", () => {
		const root = theme.components.Badge?.styles as {
			root: { fontFamily: string; textTransform: string };
		};
		expect(root.root.textTransform).toBe("uppercase");
		expect(root.root.fontFamily).toBe(FONT_MONO);
	});
});

describe("always-dark surfaces", () => {
	it("draws the terminal on the dark canvas with the dark hairline", () => {
		expect(terminalTheme.surface.background).toBe(surfaces.dark.canvas);
		expect(terminalTheme.surface.borderColor).toBe(surfaces.dark.border);
		expect(terminalTheme.colors.background).toBe(surfaces.dark.canvas);
		expect(terminalTheme.colors.cursorAccent).toBe(surfaces.dark.canvas);
	});

	it("tints the sign-in hero with the dark canvas", () => {
		expect(authHero.overlayColor).toBe(surfaces.dark.canvas);
	});
});

describe("chart colors", () => {
	const vars = mantineCssVariableResolver(theme);

	it("exposes the palette per scheme as --chart-* variables", () => {
		for (const scheme of ["dark", "light"] as const) {
			chartPalette[scheme].series.forEach((color, index) => {
				expect(vars[scheme][`--chart-${index + 1}`]).toBe(color);
			});
			expect(vars[scheme]["--chart-other"]).toBe(chartPalette[scheme].other);
			expect(vars[scheme]["--chart-grid"]).toBe(chartPalette[scheme].grid);
			expect(vars[scheme]["--chart-axis"]).toBe(chartPalette[scheme].axis);
		}
	});

	it("hands the charts the variables, so series follow the color scheme", () => {
		expect(chartSeriesColors).toEqual([
			"var(--chart-1)",
			"var(--chart-2)",
			"var(--chart-3)",
			"var(--chart-4)",
			"var(--chart-5)",
			"var(--chart-6)",
		]);
		expect(chartOtherColor).toBe("var(--chart-other)");
	});
});

describe("status colors", () => {
	it("replaces Mantine's saturated green, red, yellow, orange and blue", () => {
		for (const name of ["green", "red", "yellow", "orange", "blue"] as const) {
			expect(theme.colors[name]).toEqual(statusColors[name]);
		}
	});
});
