import { describe, expect, it } from "vitest";
import { contrastRatio, luminance } from "./contrast";
import { darkScale, surfaces } from "./surfaces";

const HEX = /^#[0-9a-f]{6}$/;

describe.each(["dark", "light"] as const)("surfaces.%s", (scheme) => {
	const s = surfaces[scheme];

	it("layers canvas <= panel <= card (frame sinks, content floats)", () => {
		expect(luminance(s.canvas)).toBeLessThanOrEqual(luminance(s.panel));
		expect(luminance(s.panel)).toBeLessThanOrEqual(luminance(s.card));
	});

	it("keeps all three text tones readable (AA) on every surface", () => {
		for (const text of [s.text1, s.text2, s.text3]) {
			for (const bg of [
				s.canvas,
				s.panel,
				s.card,
				s.control,
				s.hover,
				s.active,
			]) {
				expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it("steps text1 > text2 > text3 in contrast", () => {
		const on = (c: string) => contrastRatio(c, s.card);
		expect(on(s.text1)).toBeGreaterThan(on(s.text2));
		expect(on(s.text2)).toBeGreaterThan(on(s.text3));
	});

	it("uses plain hex everywhere except the alpha panel border", () => {
		const { borderPanel, ...rest } = s;
		expect(borderPanel).toMatch(/^rgba\(/);
		for (const value of Object.values(rest)) expect(value).toMatch(HEX);
	});
});

describe("darkScale", () => {
	it("builds a 10-step Mantine tuple from text (0) down to canvas (9)", () => {
		const scale = darkScale(surfaces.dark);
		expect(scale).toHaveLength(10);
		expect(scale[0]).toBe(surfaces.dark.text1);
		expect(scale[5]).toBe(surfaces.dark.border);
		expect(scale[9]).toBe(surfaces.dark.canvas);
	});
});
