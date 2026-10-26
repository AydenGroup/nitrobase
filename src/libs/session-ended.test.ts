import { describe, expect, it, vi } from "vitest";

// Any non-default locale code works: the prefix comes from `locales`.
vi.mock("#/libs/i18n.ts", () => ({
	locales: [{ code: "aa" }, { code: "zz" }],
}));
const { loginHref } = await import("./session-ended");

describe("loginHref", () => {
	it("keeps the locale prefix and points back to the page", () => {
		expect(
			loginHref({ pathname: "/servers/x", search: "?tab=monitoring" }),
		).toBe(
			"/login?redirect=%2Fservers%2Fx%3Ftab%3Dmonitoring&reason=session_ended",
		);
		expect(loginHref({ pathname: "/zz/apps/1", search: "" })).toBe(
			"/zz/login?redirect=%2Fzz%2Fapps%2F1&reason=session_ended",
		);
		expect(loginHref({ pathname: "/yy/apps/1", search: "" })).toBe(
			"/login?redirect=%2Fyy%2Fapps%2F1&reason=session_ended",
		);
	});
});
