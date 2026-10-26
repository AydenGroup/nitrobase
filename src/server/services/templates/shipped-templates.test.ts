import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { RuntimeSettingsSchema } from "#/features/git/schema.ts";
import {
	backupDatabaseService,
	CustomComposeSpecSchema,
	type TemplateManifest,
	TemplateManifestSchema,
} from "#/features/templates/schema.ts";
import { errorText } from "#/libs/coded.ts";
import {
	APP_NETWORKS_FILE,
	renderNetworksFile,
} from "#/server/services/apps/networks.ts";
import { buildDatabaseStrategy } from "#/server/services/backup/db-strategies.ts";
import { databaseRenderInput } from "#/server/services/databases/engines.ts";
import { gitRenderInput } from "#/server/services/git/compose.ts";
import { serverI18n } from "#/server/services/i18n.ts";
import {
	assertBindSourcesFetched,
	declaredDataPaths,
	unwrittenBindSources,
} from "./bind-sources";
import { assertSafeCompose } from "./compose-policy";
import { analyzeCustomCompose } from "./custom-compose";
import type { FetchedFile } from "./github";
import { appFolderName } from "./naming";
import {
	includedPaths,
	inlineRenderInput,
	type RenderedTemplate,
	type RenderInput,
	type RenderSettings,
	renderFromFiles,
} from "./render";
import type { RandomSource } from "./variables";

// Database engine texts are Lingui ids declared with `msg`.
vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

/**
 * Offline harness for every template in templates/: load the manifest,
 * render it with sample inputs from fixture files (upstream files are
 * checked in under __fixtures__/templates/<id>/upstream, so no network),
 * run the compose transform + policy, check that everything the manifest
 * references exists in the compose model, and snapshot the result.
 *
 * Adding a template needs `__fixtures__/templates/<id>/meta.json`
 * (`{ "version": "..." }`), plus `upstream/` when it fetches files
 * (`source.path`), or `spec.json` for an inline (custom compose) template
 * or a git template (`{ commitSha, runtime }`), or a database template
 * (`{ version, exposed, values }`).
 * Update snapshots with `bunx vitest run -u` after reviewing the diff.
 */

const root = path.resolve(__dirname, "../../../../templates");
const fixtures = path.join(__dirname, "__fixtures__", "templates");
const ids = readdirSync(root, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

/** Deterministic randomness: a counter, so snapshots are stable. */
function counterRandom(): RandomSource {
	let next = 0;
	let uuid = 0;
	return {
		bytes: (size) =>
			Buffer.from(Array.from({ length: size }, () => next++ % 256)),
		uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
	};
}

/** All files under `dir` (relative paths), like the GitHub fetcher returns. */
function readTree(dir: string, skip: Set<string> = new Set()): FetchedFile[] {
	const out: FetchedFile[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			const rel = path.relative(dir, full).split(path.sep).join("/");
			if (skip.has(rel)) continue;
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
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

function loadManifest(id: string): TemplateManifest {
	return TemplateManifestSchema.parse(
		parseToml(readFileSync(path.join(root, id, "template.toml"), "utf8")),
	);
}

const APP_ID = "0123abcd-0000-4000-8000-00000000c0de";
const DOMAIN = "app.example.org";
const COMMIT = "c0ffee0000000000000000000000000000000000";
const settings: RenderSettings = {
	appsRoot: "/etc/nitrobase/apps",
	traefikDynamicDir: "/etc/nitrobase/traefik/dynamic",
	network: "nitrobase-network",
	certResolver: "letsencrypt",
	// Real bcrypt (Traefik validates the format), fixed salt for snapshots.
	hasher: (password: string) =>
		bcrypt.hashSync(password, "$2b$04$abcdefghijklmnopqrstuu"),
};

function renderShipped(
	id: string,
	/** Render the fixture files as another upstream version. */
	versionOverride?: string,
	/** Owner overrides (template-sourced apps). */
	overrides?: Record<string, string>,
	/** Edit the upstream fixture files (e.g. a newer upstream compose). */
	patchUpstream?: (files: FetchedFile[]) => FetchedFile[],
	/** Edit the template's manifest (e.g. declare `data_binds`). */
	patchManifest?: (manifest: TemplateManifest) => TemplateManifest,
	/** Another app of the same template (its own folder and container names). */
	appId: string = APP_ID,
): {
	manifest: TemplateManifest;
	rendered: RenderedTemplate;
} {
	const manifest = (patchManifest ?? ((m) => m))(loadManifest(id));
	const dir = path.join(fixtures, id);
	const metaFile = path.join(dir, "meta.json");
	if (!existsSync(metaFile)) {
		throw new Error(
			`Missing ${path.relative(process.cwd(), metaFile)}: every template needs a fixture (see this file's header).`,
		);
	}
	const meta = JSON.parse(readFileSync(metaFile, "utf8")) as {
		version: string;
	};
	const base = {
		appId,
		appName: "Demo",
		domain: DOMAIN,
		random: counterRandom(),
		now: 1_791_000_000,
	} satisfies Partial<RenderInput>;

	if (manifest.source.type === "inline") {
		const spec = CustomComposeSpecSchema.parse(
			JSON.parse(readFileSync(path.join(dir, "spec.json"), "utf8")),
		);
		const input = inlineRenderInput(manifest, spec);
		return {
			manifest: input.manifest,
			rendered: renderFromFiles({ ...base, ...input }, settings),
		};
	}

	if (manifest.source.type === "git") {
		const spec = JSON.parse(
			readFileSync(path.join(dir, "spec.json"), "utf8"),
		) as { commitSha: string; runtime: unknown };
		const input = gitRenderInput(manifest, {
			folder: appFolderName(manifest.id, appId),
			commitSha: spec.commitSha,
			runtime: RuntimeSettingsSchema.parse(spec.runtime),
		});
		return {
			manifest: input.manifest,
			rendered: renderFromFiles({ ...base, ...input }, settings),
		};
	}

	if (manifest.source.type === "database") {
		const spec = JSON.parse(
			readFileSync(path.join(dir, "spec.json"), "utf8"),
		) as { version: string; exposed: boolean; values: Record<string, string> };
		const input = databaseRenderInput(manifest, spec);
		return {
			manifest: input.manifest,
			rendered: renderFromFiles({ ...base, ...input }, settings),
		};
	}

	const version = versionOverride ?? meta.version;
	let files: FetchedFile[];
	/** Every upstream file (fetched or not), as the GitHub tree lists them. */
	let upstreamFiles: Set<string> | null = null;
	if (manifest.source.path) {
		const upstream = path.join(dir, "upstream");
		if (!existsSync(upstream)) {
			throw new Error(
				`${id} fetches ${manifest.source.repo}/${manifest.source.path}: add the upstream files under ${path.relative(process.cwd(), upstream)}`,
			);
		}
		const include = includedPaths(manifest.source.include, version);
		const tree = (patchUpstream ?? ((all) => all))(readTree(upstream));
		upstreamFiles = new Set(tree.map((file) => file.path));
		files = tree.filter(
			(file) =>
				include.length === 0 ||
				include.some(
					(prefix) =>
						file.path === prefix || file.path.startsWith(`${prefix}/`),
				),
		);
	} else {
		files = readTree(
			path.join(root, id),
			new Set([
				"template.toml",
				manifest.logo,
				manifest.overlay,
				...manifest.overlays.map((item) => item.path),
			]),
		);
	}
	const overlayFile = path.join(root, id, manifest.overlay);
	const rendered = renderFromFiles(
		{
			...base,
			manifest,
			files,
			overlay: existsSync(overlayFile)
				? readFileSync(overlayFile, "utf8")
				: null,
			versionOverlays: manifest.overlays.map((item) => ({
				minVersion: item.min_version,
				content: readFileSync(path.join(root, id, item.path), "utf8"),
			})),
			version,
			commitSha: COMMIT,
			overrides,
		},
		settings,
	);
	// What `renderTemplate` checks against the GitHub tree at the commit.
	if (upstreamFiles) {
		assertBindSourcesFetched(
			unwrittenBindSources({
				...rendered,
				dataPaths: declaredDataPaths(manifest),
			}),
			upstreamFiles,
		);
	}
	return { manifest, rendered };
}

/** `${NAME}` / `${NAME:-x}` / `$NAME` references in a compose text (not `$$`). */
function interpolations(text: string): { name: string; hasDefault: boolean }[] {
	const out: { name: string; hasDefault: boolean }[] = [];
	const cleaned = text.replace(/\$\$/g, "");
	for (const match of cleaned.matchAll(
		/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+][^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
	)) {
		out.push({
			name: match[1] ?? match[3],
			hasDefault: !!match[2] && /^:?[-+]/.test(match[2]),
		});
	}
	return out;
}

describe.each(ids)("template %s", (id) => {
	const { manifest, rendered } = renderShipped(id);
	const model = rendered.composeModel as {
		services: Record<string, Record<string, unknown>>;
		volumes?: Record<string, unknown>;
	};
	const services = Object.keys(model.services);

	it("passes the compose policy", () => {
		expect(() =>
			assertSafeCompose(rendered.composeModel, rendered.policy, "raw"),
		).not.toThrow();
		// The policy must not have been widened silently.
		const allowed = manifest.security;
		if (
			allowed.privileged ||
			allowed.docker_socket ||
			allowed.host_network ||
			allowed.host_pid ||
			allowed.host_paths.length
		) {
			expect(allowed.reason).toBeTruthy();
		}
	});

	it("routes, probes and backs up services that exist", () => {
		for (const route of rendered.routes) {
			expect(services).toContain(route.service);
		}
		const health = manifest.health?.service;
		if (health) expect(services).toContain(health);
		const volumes = Object.keys(model.volumes ?? {});
		for (const volume of [
			...manifest.backup.volumes,
			...manifest.backup.reset_volumes,
		]) {
			expect(volumes).toContain(volume);
		}
		const database = backupDatabaseService(manifest.backup);
		if (database) expect(services).toContain(database);
		if (
			manifest.backup.database &&
			typeof manifest.backup.database !== "string"
		) {
			const strategy = buildDatabaseStrategy(manifest.backup.database);
			expect(strategy.dumpCommand(`${rendered.folder}-${database}`)).toMatch(
				/^docker exec /,
			);
		}
		const stop = manifest.backup.stop;
		if (Array.isArray(stop)) {
			for (const service of stop) expect(services).toContain(service);
		}
		for (const port of manifest.ports) expect(services).toContain(port.service);
		for (const hook of manifest.backup.hooks) {
			expect(services).toContain(hook.service);
		}
	});

	it("defines every variable the compose file interpolates", () => {
		const missing = interpolations(rendered.compose)
			.filter((ref) => !ref.hasDefault && !(ref.name in rendered.values))
			.map((ref) => ref.name);
		expect([...new Set(missing)]).toEqual([]);
	});

	it("labels every named volume nitrobase.app", () => {
		const volumes = (rendered.composeModel.volumes ?? {}) as Record<
			string,
			{ external?: boolean; labels?: Record<string, string> }
		>;
		const named = Object.keys(volumes).filter((key) => !volumes[key].external);
		for (const key of named) {
			expect(volumes[key].labels, key).toMatchObject({
				"nitrobase.app": APP_ID,
			});
		}
	});

	it("matches the snapshot", async () => {
		await expect(rendered.compose).toMatchFileSnapshot(
			`__snapshots__/templates/${id}.compose.yml`,
		);
		// ECDSA signatures are randomized: the ES256 JWTs' signatures are masked
		// (their keys and claims stay in the snapshot). Opaque secret keys are
		// masked too, so secret scanners (GitHub push protection) don't take
		// the test values for leaked credentials.
		await expect(
			rendered.envFile
				.replace(
					/(eyJhbGciOiJFUzI1NiIs[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.)[A-Za-z0-9_-]+/g,
					"$1<es256-signature>",
				)
				.replace(/\b(sb_secret_)[A-Za-z0-9_-]+/g, "$1<opaque-key>"),
		).toMatchFileSnapshot(`__snapshots__/templates/${id}.env`);
		await expect(rendered.traefik?.yaml ?? "").toMatchFileSnapshot(
			`__snapshots__/templates/${id}.traefik.yml`,
		);
		expect({
			files: rendered.files.map((file) => file.path),
			// Coded warnings, as the source-language text they render to.
			warnings: rendered.warnings.map((warning) =>
				errorText(serverI18n(), warning),
			),
		}).toMatchSnapshot();
	});
});

describe("version-gated variables and overlays (supabase new API keys)", () => {
	const keys = [
		"SUPABASE_PUBLISHABLE_KEY",
		"SUPABASE_SECRET_KEY",
		"JWT_KEYS",
		"JWT_JWKS",
		"ANON_KEY_ASYMMETRIC",
		"SERVICE_ROLE_KEY_ASYMMETRIC",
	];
	const environment = (rendered: RenderedTemplate, service: string) =>
		(
			rendered.composeModel as {
				services: Record<string, { environment: Record<string, string> }>;
			}
		).services[service].environment;

	it("generates the keys and enables asymmetric verification from v1.26.04", () => {
		const { rendered } = renderShipped("supabase", "v1.26.04");
		for (const name of keys) expect(rendered.values[name]).not.toBe("");
		expect(environment(rendered, "auth").GOTRUE_JWT_KEYS).toBe("${JWT_KEYS}");
		expect(environment(rendered, "realtime").API_JWT_JWKS).toBe("${JWT_JWKS}");
		expect(environment(rendered, "storage").JWT_JWKS).toBe("${JWT_JWKS}");
		expect(environment(rendered, "functions").SUPABASE_JWKS).toBe(
			"${JWT_JWKS}",
		);
	});

	it("leaves older releases on upstream's legacy-only setup", () => {
		const { rendered } = renderShipped("supabase", "v1.26.03");
		// Upstream's own (empty) defaults from the fixture, nothing generated.
		for (const name of keys) expect(rendered.values[name] ?? "").toBe("");
		expect(environment(rendered, "auth")).not.toHaveProperty("GOTRUE_JWT_KEYS");
		expect(environment(rendered, "realtime")).not.toHaveProperty(
			"API_JWT_JWKS",
		);
		expect(environment(rendered, "functions")).not.toHaveProperty(
			"SUPABASE_JWKS",
		);
	});
});

describe("two supabase apps on one server (BUG-006)", () => {
	const OTHER_APP = "4567ef01-0000-4000-8000-00000000beef";
	const apps = [APP_ID, OTHER_APP].map(
		(appId) =>
			renderShipped(
				"supabase",
				undefined,
				undefined,
				undefined,
				undefined,
				appId,
			).rendered,
	);

	it("never puts a service on the shared proxy network through compose", () => {
		for (const rendered of apps) {
			const model = rendered.composeModel as {
				services: Record<string, { networks?: Record<string, unknown> }>;
				networks?: Record<string, { name?: string }>;
			};
			// `kong`/`studio` of one app resolved to both apps' containers.
			for (const [name, service] of Object.entries(model.services)) {
				expect(Object.keys(service.networks ?? {}), name).not.toContain(
					"nitrobase_proxy",
				);
			}
			expect(
				Object.values(model.networks ?? {}).map((network) => network.name),
			).not.toContain(settings.network);
		}
	});

	it("attaches exactly each app's routed containers, by container name", () => {
		const [first, second] = apps;
		const routed = (rendered: RenderedTemplate) =>
			[...new Set(rendered.routes.map((route) => route.service))].sort();
		for (const rendered of apps) {
			expect(
				[...rendered.networkAttachments].sort((a, b) =>
					a.container.localeCompare(b.container),
				),
			).toEqual(
				routed(rendered).map((service) => ({
					container: rendered.containerNames[service],
					network: settings.network,
				})),
			);
			const file = rendered.files.find(
				(item) => item.path === APP_NETWORKS_FILE,
			);
			expect(file?.content.toString()).toBe(
				renderNetworksFile(rendered.networkAttachments),
			);
		}
		// Same service names, distinct names on the shared network.
		expect(routed(first)).toEqual(routed(second));
		const names = apps.flatMap((rendered) =>
			rendered.networkAttachments.map((item) => item.container),
		);
		expect(new Set(names).size).toBe(names.length);
		expect(names).not.toContain("kong");
		expect(names).not.toContain("studio");
	});
});

describe("supabase edge functions JSR mirror (rewrite)", () => {
	const MAIN = "volumes/functions/main/index.ts";
	const main = (rendered: RenderedTemplate) =>
		rendered.files.find((file) => file.path === MAIN)?.content.toString() ?? "";

	it("loads the main service's jsr: imports from esm.sh by default", () => {
		const { rendered } = renderShipped("supabase");
		expect(main(rendered)).toMatch(
			/["']https:\/\/esm\.sh\/jsr\/@panva\/jose@6["']/,
		);
		expect(main(rendered)).not.toContain("jsr:@");
		expect(rendered.warnings.map((w) => w.code)).not.toContain(
			"TEMPLATE_WARN_REWRITE_UNMATCHED",
		);
	});

	it("deploys upstream's main service unchanged when the mirror is cleared", () => {
		const { rendered } = renderShipped("supabase", undefined, {
			FUNCTIONS_JSR_MIRROR: "",
		});
		expect(main(rendered)).toMatch(/["']jsr:@panva\/jose@6["']/);
	});

	it("loads the main service's jsr: imports from the mirror when set", () => {
		const { rendered } = renderShipped("supabase", undefined, {
			FUNCTIONS_JSR_MIRROR: "https://mirror.example.test/jsr",
		});
		expect(main(rendered)).toMatch(
			/["']https:\/\/mirror\.example\.test\/jsr\/@panva\/jose@6["']/,
		);
		expect(main(rendered)).not.toContain("jsr:@");
		expect(rendered.warnings.map((w) => w.code)).not.toContain(
			"TEMPLATE_WARN_REWRITE_UNMATCHED",
		);
	});

	it("refuses mirror values that could escape the import string", () => {
		expect(() =>
			renderShipped("supabase", undefined, {
				FUNCTIONS_JSR_MIRROR: "https://x.test/'+Deno.exit()+'",
			}),
		).toThrow();
	});
});

describe("default restart policy (BUG-015)", () => {
	it("brings every long-running Appwrite service back after a reboot", () => {
		settings.defaultRestart = "unless-stopped";
		try {
			const { rendered } = renderShipped("appwrite");
			const services = parseYaml(rendered.compose).services as Record<
				string,
				{ restart?: string }
			>;
			// Upstream declares none for these four.
			for (const name of [
				"appwrite",
				"postgresql",
				"redis",
				"appwrite-browser",
			]) {
				expect(services[name]?.restart, name).toBe("unless-stopped");
			}
			expect(
				Object.entries(services)
					.filter(([, service]) => !service.restart)
					.map(([name]) => name),
			).toEqual([]);
		} finally {
			delete settings.defaultRestart;
		}
	});
});

describe("bind-mounted upstream files (appwrite 2.4.0 clickhouse)", () => {
	const CLICKHOUSE_VOLUME =
		"      - appwrite-clickhouse:/var/lib/clickhouse:rw\n";
	/** Upstream 2.4.0's compose: ClickHouse mounts its config and init script. */
	const compose240 = (files: FetchedFile[]) =>
		files.map((file) => {
			if (file.path !== "docker-compose.yml") return file;
			const text = file.content.toString("utf8");
			expect(text).toContain(CLICKHOUSE_VOLUME);
			return {
				...file,
				content: Buffer.from(
					text.replace(
						CLICKHOUSE_VOLUME,
						`${CLICKHOUSE_VOLUME}      - ./clickhouse-config.xml:/etc/clickhouse-server/config.d/appwrite.xml:ro\n      - ./clickhouse-init.sh:/docker-entrypoint-initdb.d/clickhouse-init.sh:ro\n`,
					),
				),
			};
		});

	it("fetches the files 2.4.0 bind-mounts and marks them as file binds", () => {
		const { rendered } = renderShipped(
			"appwrite",
			"2.4.0",
			undefined,
			compose240,
		);
		const paths = rendered.files.map((file) => file.path);
		expect(paths).toContain("clickhouse-config.xml");
		expect(paths).toContain("clickhouse-init.sh");
		expect(rendered.fileBinds.required).toEqual(
			expect.arrayContaining([
				{ service: "clickhouse", path: "clickhouse-config.xml" },
				{ service: "clickhouse", path: "clickhouse-init.sh" },
				{ service: "mongodb", path: "mongo-init.js" },
			]),
		);
		expect(rendered.fileBinds.named).toEqual([]);
	});

	it("does not fetch them for releases before 2.4.0 (upstream has none)", () => {
		const { rendered } = renderShipped("appwrite", "2.3.0");
		const paths = rendered.files.map((file) => file.path);
		expect(paths).not.toContain("clickhouse-config.xml");
		expect(paths).not.toContain("clickhouse-init.sh");
	});

	it("refuses a compose that mounts an upstream file the include misses (the incident)", () => {
		// 2.3.0's include (no ClickHouse files) with 2.4.0's compose: what the
		// template deployed before the fix.
		let error: unknown;
		try {
			renderShipped("appwrite", "2.3.0", undefined, compose240);
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({
			code: "TEMPLATE_BIND_SOURCE_MISSING",
			params: { service: "clickhouse", path: "clickhouse-config.xml" },
		});
	});

	it("leaves paths a template declares as runtime data (data_binds) alone", () => {
		const { rendered } = renderShipped(
			"appwrite",
			"2.3.0",
			undefined,
			compose240,
			(manifest) => ({
				...manifest,
				data_binds: ["clickhouse-config.xml", "clickhouse-init.sh"],
			}),
		);
		expect(rendered.fileBinds).toEqual({
			required: [
				{ service: "mongodb", path: "mongo-init.js" },
				{ service: "mongodb", path: "mongo-entrypoint.sh" },
			],
			named: [],
		});
	});
});

describe("custom compose file binds (owner's ./config.json)", () => {
	const manifest = loadManifest("custom-compose");
	const compose = [
		"services:",
		"  web:",
		"    image: nginx:1.27-alpine",
		"    volumes:",
		"      - ./config.json:/etc/app/config.json:ro",
		"      - ./data:/data",
		"",
	].join("\n");
	const render = (dataBinds: string[]) => {
		const input = inlineRenderInput(
			manifest,
			CustomComposeSpecSchema.parse({
				compose,
				routes: [{ service: "web", port: 80 }],
				dataBinds,
			}),
		);
		return renderFromFiles(
			{
				appId: APP_ID,
				domain: DOMAIN,
				random: counterRandom(),
				now: 1_791_000_000,
				...input,
			},
			settings,
		);
	};

	it("is offered in the analysis and only checked softly (the deploy proceeds)", () => {
		const analysis = analyzeCustomCompose(compose, "", {
			folder: "custom-compose-0123abcd",
			appRoot: "/etc/nitrobase/apps/custom-compose-0123abcd",
			network: "nitrobase-network",
		});
		expect(analysis.error).toBeNull();
		expect(analysis.fileBinds).toEqual(["config.json"]);
		// Rendering never refuses it: the owner may have put it on the server.
		const rendered = render([]);
		expect(rendered.fileBinds).toEqual({
			required: [],
			named: [{ service: "web", path: "config.json" }],
		});
	});

	it("is not checked once declared as created by the app", () => {
		expect(render(["config.json"]).fileBinds).toEqual({
			required: [],
			named: [],
		});
	});
});

describe.each(ids)("template %s bind mounts", (id) => {
	it("never treats a data folder as a file", () => {
		const { manifest, rendered } = renderShipped(id);
		const written = new Set(rendered.files.map((file) => file.path));
		// Every shipped template writes the files it mounts: nothing is left
		// to the name-based (soft) check.
		expect(rendered.fileBinds.named).toEqual([]);
		for (const bind of rendered.fileBinds.required) {
			expect(written.has(bind.path)).toBe(true);
			for (const dir of [
				...manifest.backup.paths,
				...manifest.backup.reset,
				...manifest.data_binds,
			]) {
				expect(bind.path === dir || bind.path.startsWith(`${dir}/`)).toBe(
					false,
				);
			}
		}
	});
});
