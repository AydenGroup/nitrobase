import { describe, expect, it } from "vitest";
import {
	DOCKER_LABELS,
	downloadName,
	hiddenFileName,
	isReservedLabel,
	labelFilter,
	labelValueTemplate,
	listLabel,
	RESOURCE_PREFIX,
	resourceName,
	storageKey,
	WEBHOOK_HEADERS,
} from "#/config/identifiers.ts";

describe("identifiers", () => {
	it("keeps writing today's exact identifiers", () => {
		expect(RESOURCE_PREFIX).toBe("nitrobase");
		expect(DOCKER_LABELS).toEqual({
			app: "nitrobase.app",
			service: "nitrobase.service",
			routed: "nitrobase.routed",
			instance: "nitrobase.instance",
			link: "nitrobase.link",
			commit: "nitrobase.commit",
			configHash: "nitrobase.config-hash",
			tunnelOnly: "nitrobase.tunnel-only",
			upgrade: "nitrobase.upgrade",
		});
		expect(resourceName("job-x")).toBe("nitrobase-job-x");
		expect(hiddenFileName("instance")).toBe(".nitrobase-instance");
		expect(WEBHOOK_HEADERS).toEqual({
			signature: "x-nitrobase-signature",
			timestamp: "x-nitrobase-timestamp",
			event: "x-nitrobase-event",
			delivery: "x-nitrobase-delivery",
		});
		expect(storageKey("a.b")).toBe("nitrobase.a.b");
		expect(downloadName("audit")).toBe("nitrobase-audit");
	});

	it("reads a label", () => {
		expect(labelValueTemplate("app")).toBe(
			'{{index .Config.Labels "nitrobase.app"}}',
		);
		expect(labelValueTemplate("instance", listLabel)).toBe(
			'{{.Label "nitrobase.instance"}}',
		);
	});

	it("filters by a label", () => {
		expect(labelFilter("app")).toBe("label=nitrobase.app");
		expect(labelFilter("instance", "i1")).toBe("label=nitrobase.instance=i1");
	});

	it("reserves labels under the prefix", () => {
		expect(isReservedLabel("nitrobase.app")).toBe(true);
		expect(isReservedLabel("NitroBase.App")).toBe(true);
		expect(isReservedLabel("nitrobase")).toBe(false);
		expect(isReservedLabel("com.example.nitrobase.x")).toBe(false);
	});
});
