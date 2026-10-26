import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { FetchedFile } from "#/server/services/templates/github.ts";

/**
 * `renderTemplate` / `getTemplateVersions` against the shipped Supabase
 * template, with GitHub replaced by the checked-in upstream fixture
 * (BUG-005: releases whose compose the policy refuses were offered).
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const root = path.resolve(__dirname, "../../..");
const upstream = path.join(
	root,
	"src/server/services/templates/__fixtures__/templates/supabase/upstream",
);

const state = vi.hoisted(() => ({
	patchCompose: null as ((compose: string) => string) | null,
	resolved: [] as string[],
	releases: [] as string[],
}));

vi.mock("#/config/server.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/config/server.ts")>();
	return {
		...actual,
		getConfig: () => ({
			TEMPLATES_DIR: path.join(root, "templates"),
			NITROBASE_ROOT: "/etc/nitrobase",
			NITROBASE_NETWORK: "nitrobase-network",
			TRAEFIK_CERT_RESOLVER: "letsencrypt",
			TRAEFIK_BASIC_AUTH_COST: 4,
			TEMPLATE_EXTRACT_MAX_FILES: 1000,
			TEMPLATE_EXTRACT_MAX_BYTES: 50_000_000,
			TEMPLATE_CACHE_TTL_MS: 0,
			GITHUB_TIMEOUT_MS: 1000,
		}),
	};
});

vi.mock("#/db/index.ts", () => ({ db: {} }));
vi.mock("#/features/settings/settings.server.ts", () => ({
	getSetting: async () => null,
}));

function readTree(dir: string): FetchedFile[] {
	const out: FetchedFile[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			const rel = path.relative(dir, full).split(path.sep).join("/");
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) {
				out.push({
					path: rel,
					content: readFileSync(full),
					executable: (statSync(full).mode & 0o111) !== 0,
				});
			}
		}
	};
	walk(dir);
	return out;
}

vi.mock("#/server/services/templates/github.ts", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("#/server/services/templates/github.ts")
		>();
	const tree = () =>
		readTree(upstream).map((file) =>
			file.path === "docker-compose.yml" && state.patchCompose
				? {
						...file,
						content: Buffer.from(
							state.patchCompose(file.content.toString("utf8")),
						),
					}
				: file,
		);
	return {
		...actual,
		createGitHubClient: () => ({
			listReleases: async () =>
				state.releases.map((tag) => ({
					tag_name: tag,
					name: tag,
					published_at: null,
					prerelease: false,
					draft: false,
				})),
			resolveCommit: async (_repo: string, ref: string) => {
				state.resolved.push(ref);
				return { sha: "c0ffee".padEnd(40, "0"), tree: "t".repeat(40) };
			},
			fetchDirectory: async (
				_repo: string,
				_sha: string,
				_tree: string,
				_dir: string | undefined,
				include: string[],
			) => ({
				files: tree().filter((file) =>
					include.some(
						(prefix) =>
							file.path === prefix || file.path.startsWith(`${prefix}/`),
					),
				),
				skipped: [],
			}),
			listFiles: async () => new Set(tree().map((file) => file.path)),
		}),
	};
});

const { dryRenderNewApp, getTemplateVersions, renderTemplate } = await import(
	"./templates.server"
);
const { templateCheck } = await import("#/server/services/apps/preflight.ts");
const { getTemplateManifest } = await import("./templates.server");

/**
 * v1.26.05's `vector` service, abbreviated to the lines the policy reads
 * (docker/docker-compose.yml at the v1.26.05 tag).
 */
const VECTOR_V1_26_05 = {
	container_name: "supabase-vector",
	image: "timberio/vector:0.53.0-alpine",
	volumes: [
		"./volumes/logs/vector.yml:/etc/vector/vector.yml:ro,z",
		"${DOCKER_SOCKET_LOCATION}:/var/run/docker.sock:ro,z",
	],
	security_opt: ["label=disable"],
};

const withVector = (compose: string) => {
	const model = parseYaml(compose) as { services: Record<string, unknown> };
	model.services.vector = VECTOR_V1_26_05;
	return stringifyYaml(model);
};

const APP_ID = "0123abcd-0000-4000-8000-00000000c0de";

beforeEach(() => {
	state.patchCompose = null;
	state.resolved = [];
	state.releases = [
		"v1.26.08",
		"v1.26.07",
		"v1.26.05",
		"v1.26.04",
		"v1.26.03",
		"v1.26.02",
	];
});

describe("supabase min_version (BUG-005)", () => {
	it("offers nothing below the template's min_version", async () => {
		const { versions, defaultRef } = await getTemplateVersions("supabase", {
			includePrereleases: true,
		});
		expect(versions.map((version) => version.ref)).toEqual([
			"v1.26.08",
			"v1.26.07",
		]);
		expect(defaultRef).toBe("v1.26.08");
	});

	it("refuses to render a version below it, before fetching anything", async () => {
		await expect(
			renderTemplate({
				templateId: "supabase",
				version: "v1.26.05",
				appId: APP_ID,
				domain: "app.example.org",
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_VERSION_NOT_OFFERED",
			params: { version: "v1.26.05" },
		});
		expect(state.resolved).toEqual([]);
	});

	it("still redeploys the commit an app already runs", async () => {
		await expect(
			renderTemplate({
				templateId: "supabase",
				version: "v1.26.05",
				commitSha: "c0ffee".padEnd(40, "0"),
				appId: APP_ID,
				domain: "app.example.org",
			}),
		).resolves.toMatchObject({ version: "v1.26.05" });
	});

	it("renders the oldest offered version", async () => {
		const manifest = await getTemplateManifest("supabase");
		const oldest = manifest.source.min_version as string;
		expect(oldest).toBe("v1.26.07");
		const rendered = await dryRenderNewApp({
			templateId: "supabase",
			version: oldest,
			appId: APP_ID,
		});
		expect(rendered?.version).toBe(oldest);
		expect(templateCheck(rendered as never)).toMatchObject({
			id: "template",
			status: "ok",
			message: { code: "template_ok", params: { version: oldest } },
		});
	});

	it("explains a policy refusal of an upstream version, socket first", async () => {
		state.patchCompose = withVector;
		const error = await renderTemplate({
			templateId: "supabase",
			version: "v1.26.08",
			appId: APP_ID,
			domain: "app.example.org",
		}).catch((caught: unknown) => caught);
		expect(error).toMatchObject({
			code: "TEMPLATE_VERSION_BLOCKED",
			params: {
				version: "v1.26.08",
				reason: {
					$error: {
						// The socket bind is what security_opt is there for.
						code: "COMPOSE_DOCKER_SOCKET",
						params: { service: "vector" },
					},
				},
			},
		});
	});

	it("pre-flight maps the dry render's refusal to an error check", async () => {
		state.patchCompose = withVector;
		const error = await dryRenderNewApp({
			templateId: "supabase",
			version: "v1.26.08",
			domain: "not a domain",
		}).catch((caught: unknown) => caught);
		const check = templateCheck({ error });
		expect(check).toMatchObject({
			id: "template",
			status: "error",
			message: {
				code: "template_refused",
				params: { message: { $error: { code: "TEMPLATE_VERSION_BLOCKED" } } },
			},
		});
		// Below min_version: refused the same way.
		const below = await dryRenderNewApp({
			templateId: "supabase",
			version: "v1.26.03",
		}).catch((caught: unknown) => caught);
		expect(templateCheck({ error: below })).toMatchObject({
			status: "error",
			message: {
				params: {
					message: { $error: { code: "TEMPLATE_VERSION_NOT_OFFERED" } },
				},
			},
		});
	});

	it("pre-flight only warns when the template cannot be fetched", () => {
		expect(templateCheck({ error: new Error("network down") })).toMatchObject({
			status: "warning",
			message: { code: "template_unchecked" },
		});
	});
});
