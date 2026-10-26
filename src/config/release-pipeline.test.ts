import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The GitHub workflows (.github/workflows) repeat a few facts of the repo:
 * keep them in step with their source.
 */
const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const workflow = (name: string) =>
	parse(read(`.github/workflows/${name}`)) as {
		jobs: Record<
			string,
			{ steps?: { uses?: string; with?: Record<string, unknown> }[] }
		>;
	};
const packageJson = JSON.parse(read("package.json")) as {
	version: string;
	scripts: Record<string, string>;
};

describe("release pipeline", () => {
	it("package.json has a semver version (tags are v<version>)", () => {
		expect(packageJson.version).toMatch(
			/^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
		);
	});

	it("README installs the current version and has no placeholders", () => {
		const readme = read("README.md");
		expect(readme).toContain(`\nVERSION=${packageJson.version}\n`);
		expect(readme).not.toMatch(/<owner>\/<repo>/);
	});

	it("CI uses the Dockerfile's Bun version", () => {
		const bun = /^FROM oven\/bun:([\d.]+)-alpine$/m.exec(
			read("Dockerfile"),
		)?.[1];
		const setup = workflow("ci.yml").jobs.checks.steps?.find((step) =>
			step.uses?.startsWith("oven-sh/setup-bun@"),
		);
		expect(bun).toBeTruthy();
		expect(String(setup?.with?.["bun-version"])).toBe(bun);
	});

	it("pins third-party actions to a commit", () => {
		for (const name of ["ci.yml", "release.yml"]) {
			const text = read(`.github/workflows/${name}`);
			for (const [, action, ref] of text.matchAll(
				/uses:\s*([\w.-]+\/[\w.-]+)@(\S+)/g,
			)) {
				if (/^(actions|docker)\//.test(action)) continue;
				expect(ref, `${name}: ${action}`).toMatch(/^[0-9a-f]{40}$/);
			}
		}
	});

	it("runs scripts that exist", () => {
		const text = read(".github/workflows/ci.yml");
		for (const [, script] of text.matchAll(/bun run ([\w:-]+)/g)) {
			expect(packageJson.scripts, script).toHaveProperty(script);
		}
	});

	it("attaches files that exist", () => {
		const text = read(".github/workflows/release.yml");
		for (const [, source] of text.matchAll(/^\s+cp (\S+) dist\//gm)) {
			expect(existsSync(path.join(ROOT, source)), source).toBe(true);
		}
	});
});
