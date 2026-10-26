import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { TemplateManifestSchema } = await import(
	"#/features/templates/schema.ts"
);
const { isReservedTemplateFile, RESERVED_TEMPLATE_FILES, renderFromFiles } =
	await import("./render");

const settings = {
	appsRoot: "/etc/nitrobase/apps",
	traefikDynamicDir: "/etc/nitrobase/traefik/dynamic",
	network: "nitrobase-network",
	certResolver: "letsencrypt",
	hasher: (password: string) => `hash:${password}`,
	instanceId: "inst-1",
};

const render = (extra: string) =>
	renderFromFiles(
		{
			manifest: TemplateManifestSchema.parse({
				id: "custom-compose",
				name: "Custom",
				source: { type: "inline" },
				domains: [{ service: "web", port: 80, primary: true }],
			}),
			files: [
				{
					path: "docker-compose.yml",
					content: Buffer.from("services:\n  web:\n    image: nginx:1\n"),
					executable: false,
				},
				{ path: extra, content: Buffer.from("x\n"), executable: false },
			],
			overlay: null,
			version: "custom",
			commitSha: "c0ffee",
			appId: "4567ef01-0000-4000-8000-000000000a99",
			domain: "web.example.org",
		},
		settings,
	);

describe("hidden files the deploy writes", () => {
	it("are reserved", () => {
		expect(RESERVED_TEMPLATE_FILES).toEqual([
			".nitrobase-instance",
			".nitrobase-networks",
		]);
		expect(isReservedTemplateFile("./.nitrobase-instance")).toBe(true);
		expect(isReservedTemplateFile("conf/.nitrobase-instance")).toBe(false);
	});

	it.each([
		".nitrobase-instance",
		".nitrobase-networks",
	])("refuses a template file named %s", (file) => {
		expect(() => render(file)).toThrow(
			expect.objectContaining({ code: "TEMPLATE_RESERVED_FILES" }),
		);
	});

	it("keeps other files, and writes its own networks file", () => {
		const rendered = render("conf/.nitrobase-instance");
		expect(rendered.files.map((file) => file.path)).toEqual([
			"conf/.nitrobase-instance",
			".nitrobase-networks",
		]);
	});
});
