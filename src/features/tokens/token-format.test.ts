import { describe, expect, it } from "vitest";
import { TOKEN_PREFIX, tokenPublicPart, tokenRowPrefix } from "./token-format";

const SECRET = "A".repeat(43);

describe("API token format", () => {
	it("issues nbk_ tokens", () => {
		expect(TOKEN_PREFIX).toBe("nbk_");
		expect(tokenRowPrefix(`nbk_abcdef012345_${SECRET}`)).toBe("abcdef012345");
	});

	it("rejects other shapes and keeps foreign secrets out of logs", () => {
		for (const bearer of [
			`xbk_abcdef012345_${SECRET}`,
			`sbk_abcdef012345_${SECRET}`,
			`nbk_ABCDEF012345_${SECRET}`,
			`nbk_abcdef012345_${SECRET}x`,
			"ghp_0123456789abcdefghijklmnopqrstuvwxyz",
		]) {
			expect(tokenRowPrefix(bearer), bearer).toBeNull();
		}
		expect(tokenPublicPart("ghp_0123456789abcdef")).toBeNull();
		expect(tokenPublicPart(`nbk_abcdef012345_${SECRET}`)).toBe(
			"nbk_abcdef012345_",
		);
	});
});
