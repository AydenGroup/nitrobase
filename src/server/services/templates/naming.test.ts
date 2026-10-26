import { describe, expect, it } from "vitest";
import hostLabels from "./__fixtures__/host-labels.json";
import { hostLabelFromName } from "./naming";

describe("hostLabelFromName", () => {
	it("turns an app name into a DNS label", () => {
		expect(hostLabelFromName("Client ACME — Blog")).toBe("client-acme-blog");
		expect(hostLabelFromName("pm-pocketbase")).toBe("pm-pocketbase");
		expect(hostLabelFromName("!!!")).toBe("");
		expect(hostLabelFromName("a".repeat(80)).length).toBe(40);
	});

	it.each(hostLabels.cases)("folds $name to ASCII", ({ name, label }) => {
		expect(hostLabelFromName(name)).toBe(label);
	});
});
