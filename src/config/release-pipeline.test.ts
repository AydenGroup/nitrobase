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

	it("builds each image natively per architecture, then tags them together", () => {
		type Job = {
			"runs-on"?: string;
			strategy?: {
				matrix?: Record<string, string[]> & {
					include?: Record<string, string>[];
				};
			};
			steps?: {
				id?: string;
				uses?: string;
				with?: Record<string, unknown>;
				env?: Record<string, string>;
				run?: string;
			}[];
		};
		const jobs = (
			parse(read(".github/workflows/release.yml")) as {
				jobs: Record<string, Job>;
			}
		).jobs;
		const { build, image } = jobs;
		const matrix = build.strategy?.matrix;
		expect(matrix?.image).toEqual(["panel", "installer"]);
		expect(matrix?.arch).toEqual(["amd64", "arm64"]);
		const include = matrix?.include ?? [];
		for (const entry of include.filter((item) => item.file)) {
			expect(existsSync(path.join(ROOT, entry.file)), entry.file).toBe(true);
		}
		// No emulation: arm64 builds on an arm64 runner.
		expect(build["runs-on"]).toBe("${{ matrix.runner }}");
		expect(include.find((entry) => entry.arch === "arm64")?.runner).toMatch(
			/-arm$/,
		);
		const installer = include.find((entry) => entry.image === "installer");
		// The installer installs its own release by default.
		expect(installer?.["build-args"]).toContain(
			"VERSION=${{ needs.version.outputs.version }}",
		);
		const push = build.steps?.find((step) =>
			step.uses?.startsWith("docker/build-push-action@"),
		);
		expect(push?.with?.file).toBe("${{ matrix.file }}");
		expect(push?.with?.platforms).toBe("linux/${{ matrix.arch }}");
		expect(String(push?.with?.outputs)).toContain("push-by-digest=true");

		// The GHCR image (matrix.name), plus the Docker Hub mirror when its
		// secrets are set, tagged from every architecture's digest.
		const meta = image.steps?.find((step) =>
			step.uses?.startsWith("docker/metadata-action@"),
		);
		expect(meta?.with?.images).toBe("${{ steps.images.outputs.list }}");
		const names = image.steps?.find((step) => step.id === "images");
		expect(names?.env?.GHCR_IMAGE).toBe("${{ matrix.name }}");
		expect(names?.run).toContain('echo "$GHCR_IMAGE"');
		expect(names?.run).toContain(
			'echo "docker.io/$namespace/${GHCR_IMAGE##*/}"',
		);
		const download = image.steps?.find((step) =>
			step.uses?.startsWith("actions/download-artifact@"),
		);
		expect(download?.with?.pattern).toBe("digest-${{ matrix.image }}-*");
		expect(
			image.steps?.some((step) =>
				step.run?.includes("docker buildx imagetools create"),
			),
		).toBe(true);
	});

	it("names the installer image after the panel image, like install.sh", () => {
		const text = read(".github/workflows/release.yml");
		expect(text).toContain('echo "image=ghcr.io/${GITHUB_REPOSITORY,,}"');
		expect(text).toContain(
			'echo "installer_image=ghcr.io/${GITHUB_REPOSITORY,,}-installer"',
		);
		expect(read("scripts/install.sh")).toMatch(
			/^INSTALLER_IMAGE="\$\{NITROBASE_INSTALLER_IMAGE:-\$DEFAULT_IMAGE_REGISTRY\/.*-installer\}"$/m,
		);
	});

	it("tags pre-releases :beta and keeps :latest stable, like install.sh and README", () => {
		const text = read(".github/workflows/release.yml");
		const script = read("scripts/install.sh");
		const stable = /^readonly STABLE_IMAGE_TAG="([^"]+)"/m.exec(script)?.[1];
		const pre = /^readonly PRERELEASE_IMAGE_TAG="([^"]+)"/m.exec(script)?.[1];
		expect(text).toContain(
			`type=raw,value=${stable},enable=\${{ needs.version.outputs.make_latest == 'true' }}`,
		);
		expect(text).toContain(
			`type=raw,value=${pre},enable=\${{ needs.version.outputs.prerelease == 'true' }}`,
		);
		// Every command in the README names a tag that exists today.
		const channel = packageJson.version.includes("-") ? pre : stable;
		const code = [...read("README.md").matchAll(/```bash\n([\s\S]*?)```/g)]
			.map((block) => block[1])
			.join("\n");
		const uses = [
			...code.matchAll(/ghcr\.io\/aydengroup\/nitrobase-installer(\S*)/g),
		];
		expect(uses.length).toBeGreaterThan(0);
		for (const [, tag] of uses) expect(tag).toBe(`:${channel}`);
	});

	it("CI builds the installer image", () => {
		const text = read(".github/workflows/ci.yml");
		expect(text).toMatch(/docker build -f installer\/Dockerfile /);
		expect(text).toMatch(/bash -n scripts\/install\.sh/);
	});
	it("attaches files that exist", () => {
		const text = read(".github/workflows/release.yml");
		for (const [, source] of text.matchAll(/^\s+cp (\S+) dist\//gm)) {
			expect(existsSync(path.join(ROOT, source)), source).toBe(true);
		}
	});
});
