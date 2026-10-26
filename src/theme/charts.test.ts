import { describe, expect, it } from "vitest";
import { chartPalette } from "./charts";
import { contrastRatio } from "./contrast";
import { surfaces } from "./surfaces";

const HEX = /^#[0-9a-f]{6}$/;

type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => {
	const v = Number.parseInt(hex.slice(1), 16);
	return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const toLinear = (c: number) => {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (l: number) => {
	const c = Math.min(1, Math.max(0, l));
	return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
};

/** Machado et al. (2009) color-vision-deficiency matrices, severity 1.0, in linear RGB. */
const CVD: Record<string, number[][]> = {
	protanopia: [
		[0.152286, 1.052583, -0.204868],
		[0.114503, 0.786281, 0.099216],
		[-0.003882, -0.048116, 1.051998],
	],
	deuteranopia: [
		[0.367322, 0.860646, -0.227968],
		[0.280085, 0.672501, 0.047413],
		[-0.01182, 0.04294, 0.968881],
	],
	tritanopia: [
		[1.255528, -0.076749, -0.178779],
		[-0.078411, 0.930809, 0.147602],
		[0.004733, 0.691367, 0.3039],
	],
};

const simulate = (hex: string, m: number[][]): Rgb => {
	const lin = toRgb(hex).map(toLinear);
	return m.map((row) =>
		toSrgb(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]),
	) as Rgb;
};

const distance = (a: Rgb, b: Rgb) =>
	Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Smallest pairwise distance between the series colors as seen under a deficiency. */
const minGap = (colors: readonly string[], matrix: number[][]) => {
	const seen = colors.map((c) => simulate(c, matrix));
	let min = Number.POSITIVE_INFINITY;
	for (let i = 0; i < seen.length; i++)
		for (let j = i + 1; j < seen.length; j++)
			min = Math.min(min, distance(seen[i], seen[j]));
	return min;
};

describe.each(["dark", "light"] as const)("chartPalette.%s", (scheme) => {
	const palette = chartPalette[scheme];
	const card = surfaces[scheme].card;

	it("has six series colors and a neutral, all plain hex", () => {
		expect(palette.series).toHaveLength(6);
		for (const color of [...palette.series, palette.other]) {
			expect(color).toMatch(HEX);
		}
	});

	it("keeps every series and the neutral visible on a card (3:1 for graphics)", () => {
		for (const color of [...palette.series, palette.other]) {
			expect(contrastRatio(color, card)).toBeGreaterThanOrEqual(3);
		}
	});

	it.each(
		Object.keys(CVD),
	)("keeps the first three series clearly apart for %s (RGB gap >= 45)", (deficiency) => {
		expect(
			minGap(palette.series.slice(0, 3), CVD[deficiency]),
		).toBeGreaterThanOrEqual(45);
	});

	it.each(
		Object.keys(CVD),
	)("keeps all six series distinguishable for %s (RGB gap >= 20)", (deficiency) => {
		// Six hues cannot all be far apart for every deficiency; the legend
		// names the rest. The first three are held to the stricter bar above.
		expect(minGap(palette.series, CVD[deficiency])).toBeGreaterThanOrEqual(20);
	});

	it("draws grid and axis text from the surface tokens", () => {
		expect(palette.grid).toBe(surfaces[scheme].border);
		expect(palette.axis).toBe(surfaces[scheme].text3);
	});
});
