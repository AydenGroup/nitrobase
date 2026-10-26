import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { DATABASE_ENGINE_IDS, databaseEngines } = await import(
	"#/config/database-engines.ts"
);
const { TemplateManifestSchema } = await import(
	"#/features/templates/schema.ts"
);
const { buildDatabaseStrategy } = await import(
	"#/server/services/backup/db-strategies.ts"
);
const { assertSafeCompose } = await import(
	"#/server/services/templates/compose-policy.ts"
);
const { renderFromFiles } = await import(
	"#/server/services/templates/render.ts"
);
const { DATABASE_PORT_ID, databaseComposeYaml, databaseManifest } =
	await import("./engines");
const { linkNetwork, renderLinkEnv } = await import("./links");
const { APP_NETWORKS_FILE } = await import("../apps/networks");

/**
 * Every engine's compose through the real render pipeline (transform +
 * policy), with and without a published port, and the two sides of a
 * database link: the database service and the linked app's services join
 * the link network, the app gets the env file, nothing else may.
 */

const base = TemplateManifestSchema.parse(
	parseToml(
		readFileSync(
			path.resolve(__dirname, "../../../../templates/database/template.toml"),
			"utf8",
		),
	),
);

const settings = {
	appsRoot: "/etc/nitrobase/apps",
	traefikDynamicDir: "/etc/nitrobase/traefik/dynamic",
	network: "nitrobase-network",
	certResolver: "letsencrypt",
	hasher: (password: string) => `hash:${password}`,
	instanceId: "inst-1",
};
const DB_APP = "0123abcd-0000-4000-8000-0000000000db";
const WEB_APP = "4567ef01-0000-4000-8000-000000000a99";
const LINK = "89abcdef-0000-4000-8000-00000000c0de";

function renderDatabase(
	engine: (typeof DATABASE_ENGINE_IDS)[number],
	options: { exposed?: boolean; links?: string[] } = {},
) {
	const tag = databaseEngines[engine].defaultVersion;
	const manifest = databaseManifest(base, { engine, values: {} });
	const yaml = databaseComposeYaml({
		engine,
		tag,
		exposed: !!options.exposed,
	});
	return renderFromFiles(
		{
			manifest,
			files: [
				{
					path: "docker-compose.yml",
					content: Buffer.from(yaml),
					executable: false,
				},
			],
			overlay: null,
			version: `${engine}@${tag}`,
			commitSha: "c0ffee",
			appId: DB_APP,
			domain: "db.invalid",
			publishedPorts: options.exposed
				? { [DATABASE_PORT_ID]: databaseEngines[engine].port }
				: undefined,
			loopbackPorts: options.exposed ? [DATABASE_PORT_ID] : undefined,
			linkNetworks: (options.links ?? []).map((id) => linkNetwork(id, ["db"])),
		},
		settings,
	);
}

type Service = Record<string, unknown> & {
	networks?: Record<string, unknown>;
	ports?: unknown[];
	env_file?: string[];
};

describe.each(DATABASE_ENGINE_IDS)("database engine %s", (engine) => {
	it("renders through the transform and policy, internal network only", () => {
		const rendered = renderDatabase(engine);
		expect(() =>
			assertSafeCompose(rendered.composeModel, rendered.policy, "raw"),
		).not.toThrow();
		const model = rendered.composeModel as {
			services: Record<string, Service>;
			networks: Record<string, Record<string, unknown>>;
		};
		expect(Object.keys(model.services)).toEqual(["db"]);
		const db = model.services.db;
		expect(db.image).toBe(
			`${databaseEngines[engine].image}:${databaseEngines[engine].defaultVersion}`,
		);
		// Never on the proxy network, never published, healthchecked.
		expect(Object.keys(db.networks ?? {})).toEqual(["default"]);
		expect(model.networks.default).toEqual({ internal: true });
		expect(db.ports).toBeUndefined();
		expect(db.healthcheck).toBeTruthy();
		expect(rendered.traefik).toBeNull();
		// Memory limit from the engine default.
		expect(JSON.stringify(db.deploy)).toContain("memory");
		// Every compose variable is defined (passwords generated).
		for (const match of rendered.compose.matchAll(/\$\{([A-Z_]+)\}/g)) {
			expect(rendered.values).toHaveProperty(match[1]);
		}
		expect(rendered.values.DB_PASSWORD).toMatch(/^[A-Za-z0-9]{32}$/);
	});

	it("publishes the port on 127.0.0.1 only when enabled (network not internal)", () => {
		const rendered = renderDatabase(engine, { exposed: true });
		const model = rendered.composeModel as {
			services: Record<string, Service>;
			networks?: Record<string, Record<string, unknown>>;
		};
		const port = databaseEngines[engine].port;
		expect(model.services.db.ports).toEqual([`127.0.0.1:${port}:${port}/tcp`]);
		expect(model.networks?.default?.internal).toBeUndefined();
	});

	it("dumps with the engine's strategy", () => {
		const manifest = databaseManifest(base, {
			engine,
			values: { DB_USER: "app", DB_NAME: "app" },
		});
		const table = manifest.backup.database;
		if (!table || typeof table === "string") throw new Error("no strategy");
		const strategy = buildDatabaseStrategy(table);
		expect(strategy.dumpCommand("database-0123abcd-db")).toMatch(
			/^docker exec 'database-0123abcd-db' /,
		);
		expect(manifest.backup.stop).toBe(false);
		expect(manifest.backup.reset_volumes).toContain("data");
	});
});

describe("database links", () => {
	it("the database joins its link networks with its db service only, attached after up", () => {
		const rendered = renderDatabase("postgres", { links: [LINK] });
		const model = rendered.composeModel as {
			services: Record<string, Service>;
			networks?: Record<string, Record<string, unknown>>;
		};
		const name = `nitrobase-link-${LINK.replace(/-/g, "")}`;
		// Named in the compose file, Compose would register `db` on the link
		// network too: a linked app's own `db` service would then resolve to
		// the database (BUG-006, link variant).
		expect(Object.keys(model.services.db.networks ?? {})).toEqual(["default"]);
		expect(Object.keys(model.networks ?? {})).toEqual(["default"]);
		expect(rendered.networkAttachments).toEqual([
			{ container: "database-0123abcd-db", network: name },
		]);
		const file = rendered.files.find((item) => item.path === APP_NETWORKS_FILE);
		expect(file?.content.toString()).toBe(`database-0123abcd-db\t${name}\n`);
		expect(rendered.linkNetworks).toEqual([name]);
	});

	it("a linked app's services join the network and get the env file", () => {
		const compose = [
			"services:",
			"  web:",
			"    image: nginx:1",
			"    environment:",
			"      DATABASE_URL: overridden",
			"  worker:",
			"    image: busybox:1",
			"",
		].join("\n");
		const env = renderLinkEnv(
			"postgres",
			{ host: "database-0123abcd-db", port: 5432 },
			{ user: "app", password: "p@ss", database: "app" },
			[
				{ name: "DATABASE_URL", part: "url" },
				{ name: "PGHOST", part: "host" },
			],
		);
		const rendered = renderFromFiles(
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
						content: Buffer.from(compose),
						executable: false,
					},
				],
				overlay: null,
				version: "custom",
				commitSha: "c0ffee",
				appId: WEB_APP,
				domain: "web.example.org",
				linkNetworks: [linkNetwork(LINK, "all")],
				linkEnv: env,
			},
			settings,
		);
		const model = rendered.composeModel as {
			services: Record<string, Service>;
		};
		const name = `nitrobase-link-${LINK.replace(/-/g, "")}`;
		expect(rendered.networkAttachments).toEqual([
			{
				container: "custom-compose-4567ef01-web",
				network: "nitrobase-network",
			},
			{ container: "custom-compose-4567ef01-web", network: name },
			{ container: "custom-compose-4567ef01-worker", network: name },
		]);
		for (const service of ["web", "worker"]) {
			expect(Object.keys(model.services[service].networks ?? {})).toEqual([
				"default",
			]);
			expect(model.services[service].env_file).toContain(
				"/etc/nitrobase/apps/custom-compose-4567ef01/database-links.env",
			);
		}
		const file = rendered.files.find(
			(item) => item.path === "database-links.env",
		);
		expect(file?.content.toString()).toContain(
			"DATABASE_URL='postgresql://app:p%40ss@database-0123abcd-db:5432/app'",
		);
		// The compose's own `environment` wins over the env file: warned.
		expect(rendered.warnings).toContainEqual({
			code: "TEMPLATE_WARN_LINKED_IGNORED",
			params: { service: "web", name: "DATABASE_URL" },
			text: null,
		});
		expect(() =>
			assertSafeCompose(rendered.composeModel, rendered.policy, "raw"),
		).not.toThrow();
	});

	it("an owner compose can't claim a link network", () => {
		const key = `nitrobase_link_${LINK.replace(/-/g, "")}`;
		const name = `nitrobase-link-${LINK.replace(/-/g, "")}`;
		const render = (compose: string) =>
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
							content: Buffer.from(compose),
							executable: false,
						},
					],
					overlay: null,
					version: "custom",
					commitSha: "c0ffee",
					appId: WEB_APP,
					domain: "web.example.org",
				},
				settings,
			);
		expect(() =>
			render(
				`services:\n  web:\n    image: nginx:1\n    networks: [${key}]\nnetworks:\n  ${key}:\n    external: true\n    name: ${name}\n`,
			),
		).toThrow(/reserved for database links|not allowed/);
		expect(() =>
			render(
				`services:\n  web:\n    image: nginx:1\n    networks: [x]\nnetworks:\n  x:\n    external: true\n    name: ${name}\n`,
			),
		).toThrow(/reserved for database links|not allowed/);
	});

	it("the policy keeps every service off a link network in the compose file", () => {
		const rendered = renderDatabase("postgres", { links: [LINK] });
		const model = structuredClone(rendered.composeModel) as {
			services: Record<string, Service>;
		};
		const key = `nitrobase_link_${LINK.replace(/-/g, "")}`;
		model.services.extra = {
			...model.services.db,
			container_name: "database-0123abcd-extra",
			networks: { default: {}, [key]: {} },
		};
		expect(() => assertSafeCompose(model, rendered.policy, "raw")).toThrow(
			/reserved for database links/,
		);
	});

	it("keeps engine compose files parseable YAML", () => {
		for (const engine of DATABASE_ENGINE_IDS) {
			const yaml = databaseComposeYaml({
				engine,
				tag: databaseEngines[engine].defaultVersion,
				exposed: false,
			});
			expect(parseYaml(yaml)).toHaveProperty("services.db");
		}
	});
});
