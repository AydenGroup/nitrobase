import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { BuildSettingsSchema } = await import("#/features/git/schema.ts");
const { detectBuilder, effectiveBuilder, exposedPort, nodeBuildCommand } =
	await import("./builders");

const settings = BuildSettingsSchema.parse({});
const probe = (files: string[], contents: Record<string, string> = {}) => ({
	files,
	contents,
});
const pkg = (value: object) => JSON.stringify(value);

describe("builder detection", () => {
	it("prefers a Dockerfile and reads EXPOSE", () => {
		const result = detectBuilder(
			probe(["Dockerfile", "package.json"], {
				Dockerfile: "FROM node\nEXPOSE 8080/tcp\nEXPOSE 9000\n",
				"package.json": pkg({ scripts: { build: "vite build" } }),
			}),
			settings,
		);
		expect(result).toEqual({
			builder: "dockerfile",
			reason: { code: "dockerfile", path: "Dockerfile" },
			port: 9000,
		});
	});

	it("uses the configured Dockerfile path", () => {
		const custom = BuildSettingsSchema.parse({
			dockerfile: { path: "docker/web.Dockerfile" },
		});
		expect(
			detectBuilder(
				probe(["docker/"], { "docker/web.Dockerfile": "FROM x" }),
				custom,
			).builder,
		).toBe("dockerfile");
		expect(detectBuilder(probe(["Dockerfile"]), custom).builder).not.toBe(
			"dockerfile",
		);
	});

	it("detects static site generators with their output folder", () => {
		expect(
			detectBuilder(
				probe(["package.json", "pnpm-lock.yaml"], {
					"package.json": pkg({
						scripts: { build: "astro build" },
						dependencies: { astro: "^5" },
					}),
				}),
				settings,
			),
		).toEqual({
			builder: "static",
			reason: { code: "static_framework", framework: "Astro" },
			port: 80,
			buildCommand:
				"corepack enable && pnpm install --frozen-lockfile && pnpm run build",
			outputDir: "dist",
		});
	});

	it("does not treat server frameworks as static", () => {
		const result = detectBuilder(
			probe(["package.json"], {
				"package.json": pkg({
					scripts: { build: "vite build", start: "node server.js" },
					dependencies: { vite: "^7", express: "^5" },
				}),
			}),
			settings,
		);
		expect(result.builder).toBe("railpack");
		expect(result.reason).toEqual({ code: "railpack", marker: "package.json" });
	});

	it("serves plain HTML as a static site", () => {
		expect(
			detectBuilder(
				probe(["index.html", "style.css"], { "index.html": "<h1>" }),
				settings,
			),
		).toMatchObject({ builder: "static", outputDir: ".", buildCommand: "" });
	});

	it("falls back to Railpack for known languages, else nothing", () => {
		expect(detectBuilder(probe(["go.mod", "main.go"]), settings).builder).toBe(
			"railpack",
		);
		expect(detectBuilder(probe(["requirements.txt"]), settings).builder).toBe(
			"railpack",
		);
		expect(detectBuilder(probe(["README.md"]), settings)).toMatchObject({
			builder: null,
			reason: { code: "nothing" },
		});
	});

	it("lets a manual choice override detection", () => {
		const detection = detectBuilder(probe(["go.mod"]), settings);
		expect(effectiveBuilder(settings, detection)).toBe("railpack");
		expect(
			effectiveBuilder(
				BuildSettingsSchema.parse({ builder: "static" }),
				detection,
			),
		).toBe("static");
	});

	it("helpers", () => {
		expect(exposedPort("FROM x\n")).toBeNull();
		expect(exposedPort("expose 3000\n")).toBe(3000);
		expect(nodeBuildCommand(["package-lock.json"])).toBe(
			"npm ci && npm run build",
		);
		expect(nodeBuildCommand([])).toBe("npm install && npm run build");
	});
});
