import { describe, expect, it } from "vitest";
import { diffEnvKeys, diffLines, formatUnifiedDiff } from "./diff";

describe("diffLines", () => {
	it("finds additions and removals", () => {
		const diff = diffLines("a\nb\nc", "a\nB\nc\nd");
		expect(diff).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "remove", text: "b" },
			{ kind: "add", text: "B" },
			{ kind: "same", text: "c" },
			{ kind: "add", text: "d" },
		]);
		expect(diffLines("x", "x").every((line) => line.kind === "same")).toBe(
			true,
		);
	});

	it("formats a compact unified diff", () => {
		const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
		const after = before.replace("l10", "L10");
		expect(formatUnifiedDiff(diffLines(before, after), 1)).toBe(
			"@@\n l9\n-l10\n+L10\n l11\n@@",
		);
	});

	it("diffs env keys without values", () => {
		expect(
			diffEnvKeys({ A: "1", B: "2", C: "3" }, { A: "1", B: "x", D: "4" }),
		).toEqual({
			added: ["D"],
			removed: ["C"],
			changed: ["B"],
		});
	});
});
