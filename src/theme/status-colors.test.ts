import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import { statusColors } from "./status-colors";
import { surfaces } from "./surfaces";

const HEX = /^#[0-9a-f]{6}$/;

describe.each(
	Object.entries(statusColors),
)("status color %s", (_name, tuple) => {
	it("is a 10-step hex tuple from light to dark", () => {
		expect(tuple).toHaveLength(10);
		for (const step of tuple) expect(step).toMatch(HEX);
	});

	it("reads as text (step 4) on dark surfaces", () => {
		for (const bg of [
			surfaces.dark.card,
			surfaces.dark.panel,
			surfaces.dark.canvas,
		]) {
			expect(contrastRatio(tuple[4], bg)).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("reads as text (step 9) on its own light tint (step 1) in the light scheme", () => {
		expect(contrastRatio(tuple[9], tuple[1])).toBeGreaterThanOrEqual(4.5);
	});

	it("reads as text at step 6 too: code often asks for e.g. red.6", () => {
		expect(contrastRatio(tuple[6], surfaces.dark.card)).toBeGreaterThanOrEqual(
			4.5,
		);
	});

	it("carries readable text on the solid fill of each scheme (dark step 6, light step 8)", () => {
		// Mantine's autoContrast picks white or black, whichever reads better.
		const best = (fill: string) =>
			Math.max(contrastRatio("#ffffff", fill), contrastRatio("#000000", fill));
		expect(best(tuple[6])).toBeGreaterThanOrEqual(4.5);
		expect(best(tuple[8])).toBeGreaterThanOrEqual(4.5);
	});
});
