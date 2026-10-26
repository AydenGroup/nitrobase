import { setupI18n } from "@lingui/core";
import { describe, expect, it, vi } from "vitest";
import { sourceLocale } from "#/libs/locale-manifest.ts";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));
const { defaultTeamName, teamDisplayName } = await import("./labels");

const id = defaultTeamName.id as string;

describe("team display name", () => {
	it("shows user text as is and a never-named team in the reader's language", () => {
		const i18n = setupI18n({
			locale: sourceLocale,
			messages: { [sourceLocale]: { [id]: "Default" } },
		});
		expect(teamDisplayName(i18n, "Acme")).toBe("Acme");
		expect(teamDisplayName(i18n, null)).toBe("Default");
	});
});
