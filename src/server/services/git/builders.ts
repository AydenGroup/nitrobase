import { builders as builderLabels } from "#/config/builders.ts";
import type {
	BuilderDetection,
	BuilderId,
	BuildSettings,
} from "#/features/git/schema.ts";
import type { RepoProbe } from "./commands";

/**
 * Builder drivers of git apps (pure). Detection looks at the build
 * folder's top-level entries and a few probed files; order matters (a
 * Dockerfile wins, then static frameworks, plain HTML, then Railpack's
 * languages). The build itself is assembled by `#/features/git/build.server.ts`
 * from each driver's `kind`.
 */

interface BuilderDriver {
	id: BuilderId;
	/** Detection (null = not this builder). */
	detect(probe: RepoProbe, settings: BuildSettings): BuilderDetection | null;
}

/** Last `EXPOSE` port of a Dockerfile (first port of that line). */
export function exposedPort(dockerfile: string): number | null {
	let port: number | null = null;
	for (const line of dockerfile.split("\n")) {
		const match = /^\s*EXPOSE\s+(\d{1,5})(?:\/tcp)?\b/i.exec(line);
		if (match) {
			const value = Number(match[1]);
			if (value > 0 && value < 65536) port = value;
		}
	}
	return port;
}

interface PackageJson {
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

function parsePackageJson(text: string | undefined): PackageJson | null {
	if (!text) return null;
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Static site generators: the dependency that marks them and the folder
 * their build writes. A server framework among the dependencies means the
 * app is not static (Railpack builds it instead).
 */
const staticFrameworks: {
	dependency: string;
	name: string;
	outputDir: string;
}[] = [
	{ dependency: "astro", name: "Astro", outputDir: "dist" },
	{ dependency: "vitepress", name: "VitePress", outputDir: ".vitepress/dist" },
	{ dependency: "@docusaurus/core", name: "Docusaurus", outputDir: "build" },
	{ dependency: "gatsby", name: "Gatsby", outputDir: "public" },
	{ dependency: "@11ty/eleventy", name: "Eleventy", outputDir: "_site" },
	{ dependency: "react-scripts", name: "Create React App", outputDir: "build" },
	{ dependency: "vite", name: "Vite", outputDir: "dist" },
];

const serverFrameworks = [
	"next",
	"nuxt",
	"@remix-run/node",
	"@react-router/node",
	"@sveltejs/adapter-node",
	"@tanstack/react-start",
	"express",
	"fastify",
	"hono",
	"koa",
	"@nestjs/core",
	"astro-node",
	"@astrojs/node",
];

/** Files that tell Railpack which language to build. */
const railpackMarkers = [
	"package.json",
	"requirements.txt",
	"pyproject.toml",
	"Pipfile",
	"go.mod",
	"Gemfile",
	"composer.json",
	"Cargo.toml",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"mix.exs",
	"deno.json",
	"deno.jsonc",
	"main.go",
	"main.py",
	"app.py",
	"Procfile",
	"start.sh",
];

/** Install + build command of a Node project, by its lockfile. */
export function nodeBuildCommand(files: string[]): string {
	if (files.includes("pnpm-lock.yaml")) {
		return "corepack enable && pnpm install --frozen-lockfile && pnpm run build";
	}
	if (files.includes("yarn.lock")) {
		return "corepack enable && yarn install --frozen-lockfile && yarn run build";
	}
	if (files.includes("package-lock.json")) return "npm ci && npm run build";
	return "npm install && npm run build";
}

const dockerfileDriver: BuilderDriver = {
	id: "dockerfile",
	detect(probe, settings) {
		const file = settings.dockerfile.path;
		const content = probe.contents[file];
		if (content === undefined) return null;
		return {
			builder: "dockerfile",
			reason: { code: "dockerfile", path: file },
			port: exposedPort(content) ?? builderLabels.dockerfile.defaultPort,
		};
	},
};

const staticDriver: BuilderDriver = {
	id: "static",
	detect(probe) {
		const pkg = parsePackageJson(probe.contents["package.json"]);
		if (pkg) {
			const deps = {
				...(pkg.dependencies ?? {}),
				...(pkg.devDependencies ?? {}),
			};
			if (!pkg.scripts?.build) return null;
			if (serverFrameworks.some((name) => name in deps)) return null;
			const framework = staticFrameworks.find(
				(item) => item.dependency in deps,
			);
			if (!framework) return null;
			return {
				builder: "static",
				reason: { code: "static_framework", framework: framework.name },
				port: builderLabels.static.defaultPort,
				buildCommand: nodeBuildCommand(probe.files),
				outputDir: framework.outputDir,
			};
		}
		if (probe.contents["index.html"] !== undefined) {
			return {
				builder: "static",
				reason: { code: "static_html" },
				port: builderLabels.static.defaultPort,
				buildCommand: "",
				outputDir: ".",
			};
		}
		return null;
	},
};

const railpackDriver: BuilderDriver = {
	id: "railpack",
	detect(probe) {
		const marker = railpackMarkers.find((name) => probe.files.includes(name));
		if (!marker) return null;
		return {
			builder: "railpack",
			reason: { code: "railpack", marker },
			port: builderLabels.railpack.defaultPort,
		};
	},
};

/** Detection order. */
const builderDrivers: BuilderDriver[] = [
	dockerfileDriver,
	staticDriver,
	railpackDriver,
];

export function detectBuilder(
	probe: RepoProbe,
	settings: BuildSettings,
): BuilderDetection {
	for (const driver of builderDrivers) {
		const found = driver.detect(probe, settings);
		if (found) return found;
	}
	return {
		builder: null,
		reason: { code: "nothing" },
		port: builderLabels.railpack.defaultPort,
	};
}

/** The builder a build uses: the manual choice, else the detection. */
export function effectiveBuilder(
	settings: BuildSettings,
	detection: BuilderDetection,
): BuilderId | null {
	return settings.builder === "auto" ? detection.builder : settings.builder;
}
