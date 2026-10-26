import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
	TemplateManifestSchema,
	validateVariableValue,
} from "#/features/templates/schema.ts";
import { appFolderName, assertHostname } from "./naming";

const root = path.resolve(__dirname, "../../../../templates");
const ids = readdirSync(root, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name);

describe("shipped templates", () => {
	it.each(ids)("%s/template.toml is valid", (id) => {
		const manifest = TemplateManifestSchema.parse(
			parse(readFileSync(path.join(root, id, "template.toml"), "utf8")),
		);
		expect(manifest.id).toBe(id);
		// Custom compose and git apps get their domains from the owner's choices.
		if (manifest.source.type === "github") {
			expect(manifest.domains.filter((d) => d.primary)).toHaveLength(1);
		}
		if (manifest.source.version_filter)
			new RegExp(manifest.source.version_filter);
	});
});

describe("naming", () => {
	it("derives folder names and validates hosts", () => {
		expect(
			appFolderName("supabase", "0123ABCD-ffff-4000-8000-000000000000"),
		).toBe("supabase-0123abcd");
		expect(() => appFolderName("Bad_Id", "x")).toThrow();
		expect(assertHostname("App.Example.ORG")).toBe("app.example.org");
		expect(() => assertHostname("x`)")).toThrow();
		expect(() => assertHostname("localhost")).toThrow();
	});
});

describe("validateVariableValue", () => {
	const base = {
		value: "",
		secret: false,
		credential: false,
		editable: true,
		type: "string" as const,
	};
	it("enforces type, length and pattern", () => {
		expect(
			validateVariableValue("E", { ...base, type: "email" }, "not-an-email"),
		).toMatchObject({
			code: "VARIABLE_TYPE_INVALID",
			params: { type: "email" },
		});
		expect(
			validateVariableValue("E", { ...base, type: "email" }, "a@b.org"),
		).toBeNull();
		expect(
			validateVariableValue("P", { ...base, min_length: 10 }, "1"),
		).toMatchObject({ code: "VARIABLE_TOO_SHORT", params: { min: 10 } });
		expect(
			validateVariableValue("U", { ...base, type: "url" }, "https://x.org"),
		).toBeNull();
		expect(
			validateVariableValue("N", { ...base, type: "integer" }, "1.5"),
		).toMatchObject({
			code: "VARIABLE_TYPE_INVALID",
			params: { type: "integer" },
		});
		expect(
			validateVariableValue("S", { ...base, pattern: "^[a-z]+$" }, "ABC"),
		).toMatchObject({ code: "VARIABLE_FORMAT_INVALID" });
	});
});

describe("health config", () => {
	const base = {
		id: "x",
		name: "X",
		source: { repo: "o/r", versions: "releases" },
		domains: [{ service: "web", port: 80, primary: true }],
	};
	it("requires the probed service to be routed", () => {
		expect(
			TemplateManifestSchema.safeParse({
				...base,
				health: { service: "db", path: "/" },
			}).success,
		).toBe(false);
		expect(
			TemplateManifestSchema.safeParse({
				...base,
				health: { service: "web", path: "/" },
			}).success,
		).toBe(true);
		expect(
			TemplateManifestSchema.safeParse({ ...base, health: { path: "/" } })
				.success,
		).toBe(true);
	});
});
