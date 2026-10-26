import { setupI18n } from "@lingui/core";
import { describe, expect, it, vi } from "vitest";
import { sourceLocale } from "#/libs/locale-manifest.ts";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { assertHttpOk } = await import("./http");
const { DeliveryError } = await import("./message");
const { describeDeliveryError } = await import(
	"#/config/notification-channels.ts"
);

const i18n = setupI18n({
	locale: sourceLocale,
	messages: { [sourceLocale]: {} },
});
i18n.activate(sourceLocale);

const kindOf = (run: () => void) => {
	try {
		run();
	} catch (error) {
		return error instanceof DeliveryError ? error.kind : "other";
	}
	return null;
};

describe("assertHttpOk", () => {
	it("classifies redirects apart from errors", () => {
		expect(kindOf(() => assertHttpOk(204, ""))).toBeNull();
		expect(kindOf(() => assertHttpOk(302, ""))).toBe("redirect");
		expect(kindOf(() => assertHttpOk(403, "no"))).toBe("auth");
		expect(kindOf(() => assertHttpOk(500, ""))).toBe("http");
	});
});

describe("describeDeliveryError", () => {
	it("shows the kind's label and the detail", () => {
		expect(describeDeliveryError(i18n, "smtp: SMTP 502 on STARTTLS")).toMatch(
			/^The mail server refused the message .*\(SMTP 502 on STARTTLS\)$/,
		);
		expect(describeDeliveryError(i18n, "redirect: HTTP 302")).toMatch(
			/redirect, which is not followed.*\(HTTP 302\)$/,
		);
		expect(describeDeliveryError(i18n, "weird")).toBe("Sending failed.");
	});
});
