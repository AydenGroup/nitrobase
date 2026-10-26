import { describe, expect, it } from "vitest";
import { ACCENT_BOOT_SCRIPT, buildAccentCss } from "./accent-css";
import { ACCENTS } from "./accents";

/** Splits generated CSS into [selector, body] pairs. */
const rules = (css: string): [string, string][] =>
	[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [
		selector.trim(),
		body,
	]);

describe("buildAccentCss", () => {
	const css = buildAccentCss();

	it("scopes every rule to :root so portals (menus, modals) get the colors too", () => {
		for (const [selector] of rules(css))
			expect(selector.startsWith(":root")).toBe(true);
	});

	it("emits a light and a dark block for every accent with all accent variables", () => {
		for (const accent of ACCENTS) {
			const light = rules(css).find(
				([s]) => s === `:root[data-accent="${accent.id}"]`,
			);
			const dark = rules(css).find(
				([s]) =>
					s ===
					`:root[data-accent="${accent.id}"][data-mantine-color-scheme="dark"]`,
			);
			expect(light, `${accent.id} light`).toBeDefined();
			expect(dark, `${accent.id} dark`).toBeDefined();
			for (const body of [light?.[1] ?? "", dark?.[1] ?? ""]) {
				for (const name of [
					"--accent-fill:",
					"--accent-on-fill:",
					"--accent-text:",
					"--accent-border:",
					"--accent-mix:",
				]) {
					expect(body).toContain(name);
				}
			}
		}
	});

	it("puts the registry values in the right scheme block", () => {
		const blue = ACCENTS.find((a) => a.id === "blue");
		const dark = rules(css).find(
			([s]) =>
				s === ':root[data-accent="blue"][data-mantine-color-scheme="dark"]',
		);
		expect(dark?.[1]).toContain(`--accent-text:${blue?.dark.text}`);
	});

	it("defines the derived hover and soft colors once, on :root", () => {
		const base = rules(css).find(([s]) => s === ":root");
		expect(base?.[1]).toContain("--accent-fill-hover:color-mix(");
		expect(base?.[1]).toContain("--accent-soft:color-mix(");
	});

	it("lists the default (mono) first so every other rule can override it", () => {
		expect(rules(css)[0][0]).toBe(":root");
		expect(rules(css)[1][0]).toBe(':root[data-mantine-color-scheme="dark"]');
	});
});

describe("ACCENT_BOOT_SCRIPT", () => {
	const run = (getItem: (key: string) => string | null) => {
		const calls: [string, string][] = [];
		const doc = {
			documentElement: {
				setAttribute: (name: string, value: string) =>
					calls.push([name, value]),
			},
		};
		new Function("document", "localStorage", ACCENT_BOOT_SCRIPT)(doc, {
			getItem,
		});
		return calls;
	};

	it("sets data-accent from a stored valid id", () => {
		expect(run(() => "violet")).toEqual([["data-accent", "violet"]]);
	});

	it.each(["red", "", null, "__proto__"])("ignores %s", (stored) => {
		expect(run(() => stored)).toEqual([]);
	});

	it("reads only the accent key", () => {
		const keys: Record<string, string> = { "other-accent": "pink" };
		const read = (key: string) => keys[key] ?? null;
		expect(run(read)).toEqual([]);
		keys["nitrobase-accent"] = "blue";
		expect(run(read)).toEqual([["data-accent", "blue"]]);
	});

	it("does not throw when storage throws (private window)", () => {
		expect(
			run(() => {
				throw new Error("denied");
			}),
		).toEqual([]);
	});
});
