import { describe, expect, it } from "vitest";
import { accentFromStorageEvent, writeAccent } from "./accent-store";

const doc = () => {
	const calls: [string, string][] = [];
	return {
		calls,
		documentElement: {
			setAttribute: (name: string, value: string) => calls.push([name, value]),
		},
	};
};

describe("writeAccent", () => {
	it("sets data-accent and stores the id", () => {
		const d = doc();
		const stored: [string, string][] = [];
		writeAccent("blue", d, {
			setItem: (k, v) => stored.push([k, v]),
		});
		expect(d.calls).toEqual([["data-accent", "blue"]]);
		expect(stored).toEqual([["nitrobase-accent", "blue"]]);
	});

	it("still applies the accent when storage throws", () => {
		const d = doc();
		expect(() =>
			writeAccent("violet", d, {
				setItem: () => {
					throw new Error("quota");
				},
			}),
		).not.toThrow();
		expect(d.calls).toEqual([["data-accent", "violet"]]);
	});
});

describe("accentFromStorageEvent", () => {
	it("follows a change made in another tab", () => {
		expect(
			accentFromStorageEvent({ key: "nitrobase-accent", newValue: "violet" }),
		).toBe("violet");
	});

	it("treats an unknown or removed value as the default", () => {
		expect(
			accentFromStorageEvent({ key: "nitrobase-accent", newValue: "zzz" }),
		).toBe("mono");
		expect(
			accentFromStorageEvent({ key: "nitrobase-accent", newValue: null }),
		).toBe("mono");
	});

	it("resets to the default when storage is cleared (key null)", () => {
		expect(accentFromStorageEvent({ key: null, newValue: null })).toBe("mono");
	});

	it("ignores other keys", () => {
		expect(
			accentFromStorageEvent({ key: "other", newValue: "blue" }),
		).toBeUndefined();
	});
});
