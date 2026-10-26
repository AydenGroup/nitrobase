import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
	readFileSync(new URL(name, import.meta.url), "utf8");

/** Files that must take every color from the surface and accent tokens. */
const FILES = ["./index.ts", "./styles.css"] as const;

describe.each(FILES)("%s uses tokens, not raw colors", (file) => {
	const source = read(file);

	it("has no gray/dark Mantine palette references (use --sb-*)", () => {
		expect(source.match(/--mantine-color-(dark|gray)-\d/g) ?? []).toEqual([]);
	});

	it("has no brand palette steps (use --accent-*)", () => {
		expect(source.match(/--mantine-color-brand-\d/g) ?? []).toEqual([]);
	});

	it("has none of the old hard-coded surface hexes", () => {
		expect(
			source.match(/#(131314|1e1f20|26282a|282a2c|242528)\b/gi) ?? [],
		).toEqual([]);
	});
});
