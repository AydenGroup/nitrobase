import { describe, expect, it } from "vitest";
import { ACCENTS, DEFAULT_ACCENT, isAccentId, parseAccent } from "./accents";
import { contrastRatio } from "./contrast";
import { surfaces } from "./surfaces";

const HEX = /^#[0-9a-f]{6}$/;

describe("parseAccent", () => {
	it("returns a known id unchanged", () => {
		expect(parseAccent("blue")).toBe("blue");
	});

	it.each([
		null,
		undefined,
		"",
		"red",
		"BLUE",
		"__proto__",
		"constructor",
		"toString",
	])("falls back to the default for %s", (raw) => {
		expect(parseAccent(raw)).toBe("mono");
	});

	it("isAccentId rejects non-strings and inherited keys", () => {
		expect(isAccentId("pink")).toBe(true);
		expect(isAccentId(42)).toBe(false);
		expect(isAccentId("hasOwnProperty")).toBe(false);
	});
});

describe("ACCENTS", () => {
	it("has six unique ids and no red or yellow (those mean error and warning)", () => {
		const ids = ACCENTS.map((a) => a.id);
		expect(new Set(ids).size).toBe(6);
		expect(ids).not.toContain("red");
		expect(ids).not.toContain("yellow");
	});

	it("contains the default and uses plain hex values", () => {
		expect(ACCENTS.map((a) => a.id)).toContain(DEFAULT_ACCENT);
		for (const accent of ACCENTS) {
			expect(accent.swatch).toMatch(HEX);
			for (const tone of [accent.dark, accent.light]) {
				for (const value of Object.values(tone)) expect(value).toMatch(HEX);
			}
		}
	});
});

describe.each(ACCENTS)("accent $id", (accent) => {
	describe.each(["dark", "light"] as const)("%s scheme", (scheme) => {
		const tone = accent[scheme];
		const s = surfaces[scheme];

		it("keeps the label on a filled button readable", () => {
			expect(contrastRatio(tone.onFill, tone.fill)).toBeGreaterThanOrEqual(4.5);
		});

		it("keeps accent text readable on every surface", () => {
			for (const bg of [s.canvas, s.panel, s.card, s.control]) {
				expect(contrastRatio(tone.text, bg)).toBeGreaterThanOrEqual(4.5);
			}
		});

		it("keeps the focus border visible against canvas and card", () => {
			expect(contrastRatio(tone.border, s.canvas)).toBeGreaterThanOrEqual(3);
			expect(contrastRatio(tone.border, s.card)).toBeGreaterThanOrEqual(3);
		});
	});
});
