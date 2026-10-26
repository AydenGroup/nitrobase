import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./shared";

describe("safeRedirectPath", () => {
	it.each([
		["/servers?x=1#a", "/servers?x=1#a"],
		["/vi/ssh-keys", "/vi/ssh-keys"],
	])("keeps same-origin path %s", (input, expected) => {
		expect(safeRedirectPath(input)).toBe(expected);
	});

	it.each([
		"https://evil.example",
		"//evil.example/x",
		"/\\evil.example",
		"javascript:alert(1)",
		"servers",
		undefined,
		42,
	])("rejects %s", (input) => {
		expect(safeRedirectPath(input)).toBe("/");
	});
});
