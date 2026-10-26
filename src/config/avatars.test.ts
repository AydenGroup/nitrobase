import { describe, expect, it } from "vitest";
import { identiconSvg } from "#/libs/identicon.ts";
import { avatarPath, avatarPresets, isAllowedAvatarUrl } from "./avatars";

describe("avatars", () => {
	it("accepts initials, generated paths and https only", () => {
		expect(isAllowedAvatarUrl("")).toBe(true);
		expect(isAllowedAvatarUrl(avatarPath("identicon", "Dax"))).toBe(true);
		expect(isAllowedAvatarUrl("https://example.com/me.png")).toBe(true);
		for (const bad of [
			"http://example.com/me.png",
			"//evil.example/me.png",
			"javascript:alert(1)",
			"data:image/svg+xml,<svg/>",
			"/api/avatars/identicon/../../etc",
			"/api/avatars/unknown/Dax",
			"/api/avatars/identicon/Dax/extra",
			"/other/path",
		]) {
			expect(isAllowedAvatarUrl(bad), bad).toBe(false);
		}
	});

	it("offers presets for every style", () => {
		const presets = avatarPresets();
		expect(presets.length).toBeGreaterThan(0);
		for (const preset of presets) {
			expect(isAllowedAvatarUrl(preset.url)).toBe(true);
		}
	});

	it("renders deterministic, distinct identicons", () => {
		expect(identiconSvg("Dax")).toBe(identiconSvg("Dax"));
		expect(identiconSvg("Dax")).not.toBe(identiconSvg("Izumi"));
		expect(identiconSvg("Dax")).toMatch(/^<svg [^>]+>.*<\/svg>$/);
	});
});
