import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

// The Lingui macro is compiled by Babel in the app; tests use descriptors.
vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { hasCapability, pluginFor, pluginTabsFor, providerPlugins } =
	await import("./registry");
const { tabsForTemplate } = await import("#/config/app-tabs.ts");
const { TemplateManifestSchema } = await import(
	"#/features/templates/schema.ts"
);
const { SupabasePluginConfigSchema } = await import(
	"#/features/supabase/schema.ts"
);
const { edgeFunctionStarters } = await import("./supabase/starters");
const { CAPABILITY_PATTERN } = await import("./types");
const { isPermission } = await import("#/config/permissions.ts");

describe("provider plugin registry", () => {
	it("has one plugin per template, each matching a template directory", () => {
		const ids = providerPlugins.map((plugin) => plugin.templateId);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			const manifest = TemplateManifestSchema.parse(
				parse(readFileSync(`templates/${id}/template.toml`, "utf8")),
			);
			expect(manifest.id).toBe(id);
		}
	});

	it("declares unique tabs, each backed by a declared capability and a lazy loader", () => {
		const tabIds = providerPlugins.flatMap((plugin) =>
			plugin.tabs.map((tab) => tab.id),
		);
		expect(new Set(tabIds).size).toBe(tabIds.length);
		for (const plugin of providerPlugins) {
			for (const tab of plugin.tabs) {
				expect(plugin.capabilities).toContain(tab.capability);
				expect(typeof tab.load).toBe("function");
				if (tab.permission) expect(isPermission(tab.permission)).toBe(true);
				expect(tab.label.id).toBeTruthy();
			}
		}
	});

	it("declares capability ids as kebab-case, once per plugin", () => {
		for (const plugin of providerPlugins) {
			expect(new Set(plugin.capabilities).size).toBe(
				plugin.capabilities.length,
			);
			for (const capability of plugin.capabilities) {
				expect(capability).toMatch(CAPABILITY_PATTERN);
			}
		}
	});

	it("registers Supabase with its capabilities and tabs before Settings", () => {
		expect(pluginFor("supabase")?.capabilities).toEqual([
			"api-keys",
			"studio",
			"edge-functions",
			"db-functions",
			"cloud-sync",
			"storage-repair",
		]);
		expect(hasCapability("supabase", "db-functions")).toBe(true);
		expect(hasCapability("pocketbase", "db-functions")).toBe(false);
		expect(pluginTabsFor("pocketbase")).toEqual([]);
		const ids = tabsForTemplate("supabase").map((tab) => tab.id);
		expect(ids.slice(-5)).toEqual([
			"supabase-api",
			"supabase-edge-functions",
			"supabase-db-functions",
			"supabase-cloud-sync",
			"settings",
		]);
		expect(tabsForTemplate("pocketbase").map((tab) => tab.id)).not.toContain(
			"supabase-api",
		);
	});

	it("has a valid [plugin] config in the Supabase template", () => {
		const manifest = TemplateManifestSchema.parse(
			parse(readFileSync("templates/supabase/template.toml", "utf8")),
		);
		const config = SupabasePluginConfigSchema.parse(manifest.plugin);
		expect(manifest.service_env).toContain(config.functions_service);
		expect(manifest.variables[config.jwt_secret]?.rotatable).toBe(true);
		expect(manifest.variables[config.studio_password]?.rotatable).toBe(true);
		expect(
			manifest.domains.find((d) => d.service === config.studio_service)
				?.basic_auth,
		).toEqual({
			username: config.studio_username,
			password: config.studio_password,
		});
		for (const id of config.pooler_ports) {
			expect(manifest.ports.map((port) => port.id)).toContain(id);
		}
	});

	it("ships edge function starters with valid files", () => {
		expect(edgeFunctionStarters.map((starter) => starter.id)).toEqual([
			"hello-world",
			"cors",
			"supabase-js",
		]);
		for (const starter of edgeFunctionStarters) {
			expect(starter.files.some((file) => file.path === "index.ts")).toBe(true);
		}
	});
});
