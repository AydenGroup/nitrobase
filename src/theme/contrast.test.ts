import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";

describe("contrastRatio", () => {
	it("is 21 for black on white", () => {
		expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
	});

	it("is 1 for identical colors", () => {
		expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
	});

	it("is symmetric", () => {
		expect(contrastRatio("#3b82f6", "#111212")).toBeCloseTo(
			contrastRatio("#111212", "#3b82f6"),
			10,
		);
	});

	it("matches the published value for #777777 on white", () => {
		expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
	});
});
