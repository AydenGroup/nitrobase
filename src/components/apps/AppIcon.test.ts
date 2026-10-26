import { describe, expect, it } from "vitest";
import { appSources } from "#/config/app-sources.ts";
import { TemplateManifestSchema } from "#/features/templates/schema.ts";
import { getAppVisual } from "./AppIcon";

describe("getAppVisual", () => {
	it("uses the template's colour over its source kind's", () => {
		expect(
			getAppVisual({ sourceKind: "template", color: "teal", hasLogo: true }),
		).toEqual({ icon: appSources.template.icon, color: "teal", hasLogo: true });
	});

	it("falls back to the source kind's icon and colour", () => {
		expect(
			getAppVisual({ sourceKind: "git", color: null, hasLogo: false }),
		).toEqual({
			icon: appSources.git.icon,
			color: appSources.git.color,
			hasLogo: false,
		});
	});

	it("treats an unknown template as a template app and still tries its logo", () => {
		expect(getAppVisual(undefined)).toEqual({
			icon: appSources.template.icon,
			color: appSources.template.color,
			hasLogo: true,
		});
	});
});

describe("template color", () => {
	const shape = TemplateManifestSchema.shape.color;

	it("accepts a Mantine palette colour and nothing else", () => {
		expect(shape.safeParse("teal").success).toBe(true);
		expect(shape.safeParse(undefined).success).toBe(true);
		expect(shape.safeParse("#ff0000").success).toBe(false);
		expect(shape.safeParse("chartreuse").success).toBe(false);
	});
});
