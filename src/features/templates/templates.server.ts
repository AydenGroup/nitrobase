import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { appSourceKindOf } from "#/config/app-sources.ts";
import { defaultRestartOf } from "#/config/restart-policies.ts";
import { getConfig, hostPaths } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { templatesCache } from "#/db/schema/templates.ts";
import { getSetting } from "#/features/settings/settings.server.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { isGeneratedExpression } from "#/server/services/apps/env-state.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import { currentInstanceId } from "#/server/services/instance-state.ts";
import {
	assertBindSourcesFetched,
	declaredDataPaths,
	needsUpstreamListing,
	unwrittenBindSources,
} from "#/server/services/templates/bind-sources.ts";
import {
	analyzeCustomCompose,
	type CustomComposeAnalysis,
} from "#/server/services/templates/custom-compose.ts";
import {
	type CacheStore,
	createGitHubClient,
	type FetchedFile,
	GitHubError,
	GitHubRateLimitError,
} from "#/server/services/templates/github.ts";
import {
	appFolderName,
	assertHostname,
	ENV_NAME_PATTERN,
	RESERVED_ENV_PATTERN,
	TemplateError,
	templateError,
} from "#/server/services/templates/naming.ts";
import {
	INLINE_VERSION,
	includedPaths,
	type RenderedTemplate,
	type RenderInput,
	type RenderSettings,
	renderFromFiles,
	withUpstreamRefusals,
} from "#/server/services/templates/render.ts";
import { bcryptHasher } from "#/server/services/templates/route-auth.ts";
import { parseEnvFile } from "#/server/services/templates/variables.ts";
import {
	compareVersionNames,
	defaultVersion,
	filterVersions,
	isVersionOffered,
	versionOffer,
	versionsFromBranches,
	versionsFromCommits,
	versionsFromReleases,
	versionsFromTags,
} from "#/server/services/templates/versions.ts";
import { AppError, coded } from "#/utils/error.ts";
import {
	allowedSecurity,
	type CustomComposeSpec,
	isVersionRefForSource,
	type TemplateManifest,
	TemplateManifestSchema,
	type TemplateProblem,
	type TemplateSummary,
	type TemplateVersion,
} from "./schema";

const MANIFEST_FILE = "template.toml";

export {
	isSecretFile,
	serviceEnvFile,
} from "#/server/services/templates/render.ts";

/** Version refs: tags/branches like `v1.2.3` or `n8n@1.2.3`, or a SHA. */
const REF_PATTERN = /^[\w][\w./@-]{0,199}$/;

interface LoadedTemplate {
	manifest: TemplateManifest;
	dir: string;
}

// ---------------------------------------------------------------------------
// Registry: every directory under TEMPLATES_DIR with a template.toml.

interface Registry {
	templates: Map<string, LoadedTemplate>;
	/** Folders whose template.toml failed to load (shown to admins). */
	problems: TemplateProblem[];
}

let registry: Promise<Registry> | null = null;

function templatesRoot(): string {
	return path.resolve(process.cwd(), getConfig().TEMPLATES_DIR);
}

/** A load failure: coded, with every zod issue and its path as detail. */
function problemOf(error: unknown): ErrorInfo {
	if (error instanceof z.ZodError) {
		return coded("TEMPLATE_MANIFEST_INVALID", {
			detail: error.issues
				.map((issue) =>
					issue.path.length
						? `${issue.path.join(".")}: ${issue.message}`
						: issue.message,
				)
				.join("\n"),
		});
	}
	if (error instanceof AppError) {
		return coded(error.code, error.params as never);
	}
	return coded("TEMPLATE_MANIFEST_INVALID", {
		detail: error instanceof Error ? error.message : String(error),
	});
}

async function loadRegistry(): Promise<Registry> {
	const root = templatesRoot();
	const templates = new Map<string, LoadedTemplate>();
	const problems: TemplateProblem[] = [];
	if (!existsSync(root)) return { templates, problems };
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		const file = path.join(dir, MANIFEST_FILE);
		if (!existsSync(file)) continue;
		try {
			const manifest = TemplateManifestSchema.parse(
				parseToml(await readFile(file, "utf8")),
			);
			if (manifest.id !== entry.name) {
				throw new TemplateError("TEMPLATE_ID_MISMATCH", {
					id: manifest.id,
					folder: entry.name,
				});
			}
			templates.set(manifest.id, { manifest, dir });
		} catch (error) {
			console.error(`[templates] skipping ${entry.name}:`, error);
			problems.push({ folder: entry.name, error: problemOf(error) });
		}
	}
	return { templates, problems };
}

async function getRegistry() {
	// Re-read on every call in development so template edits show up.
	if (process.env.NODE_ENV !== "production") registry = null;
	registry ??= loadRegistry();
	return registry;
}

export async function getTemplateManifest(
	templateId: string,
): Promise<TemplateManifest> {
	return (await getTemplate(templateId)).manifest;
}

async function getTemplate(templateId: string): Promise<LoadedTemplate> {
	const template = (await getRegistry()).templates.get(templateId);
	if (!template) throw new AppError("TEMPLATE_NOT_FOUND");
	return template;
}

function summarize({ manifest, dir }: LoadedTemplate): TemplateSummary {
	return {
		inputs: Object.entries(manifest.variables)
			.filter(([, variable]) => variable.editable)
			.map(([name, variable]) => ({
				name,
				description: variable.description,
				secret: variable.secret,
				type: variable.type,
				minLength: variable.min_length,
				label: variable.label,
				group: variable.group,
				generated: isGeneratedExpression(variable.value),
				prefill: variable.prefill,
				permission: variable.permission,
				// Expressions like `admin@${domain}` are not shown raw.
				placeholder:
					variable.secret || variable.value.includes("${")
						? undefined
						: variable.value,
			})),
		id: manifest.id,
		name: manifest.name,
		description: manifest.description,
		notes: manifest.notes ?? null,
		limitation: manifest.limitation ?? null,
		category: manifest.category,
		website: manifest.website,
		docs: manifest.docs,
		tags: manifest.tags,
		hasLogo: existsSync(path.join(dir, manifest.logo)),
		color: manifest.color ?? null,
		versionSource:
			manifest.source.type === "github"
				? manifest.source.versions
				: manifest.source.type,
		sourceKind: appSourceKindOf(manifest.source.type),
		requirements: {
			memoryMb: manifest.requirements.memory_mb,
			diskMb: manifest.requirements.disk_mb,
		},
		minDockerVersion: manifest.min_docker_version ?? null,
		advanced: manifest.advanced,
		repo: manifest.source.repo ?? null,
		security: {
			allows: allowedSecurity(manifest.security),
			reason: manifest.security.reason ?? null,
		},
	};
}

/** Custom compose template (no upstream, per-app compose). */
export async function isInlineTemplate(templateId: string): Promise<boolean> {
	const template = (await getRegistry()).templates.get(templateId);
	return template?.manifest.source.type === "inline";
}

/** Logo bytes for a template (only from its own directory). */
export async function readTemplateLogo(
	templateId: string,
): Promise<Buffer | null> {
	const template = (await getRegistry()).templates.get(templateId);
	if (!template) return null;
	const file = path.resolve(template.dir, template.manifest.logo);
	if (!file.startsWith(`${template.dir}${path.sep}`) || !file.endsWith(".svg"))
		return null;
	return readFile(file).catch(() => null);
}

/** Template folders that failed validation, for their authors. */
export async function listTemplateProblems(): Promise<TemplateProblem[]> {
	return (await getRegistry()).problems;
}

export async function listTemplates(): Promise<TemplateSummary[]> {
	return [...(await getRegistry()).templates.values()]
		.map(summarize)
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// GitHub access (DB-backed cache).

/** GitHub API cache (templates_cache table; also used by the Nitrobase release check). */
export const dbCache: CacheStore = {
	async get(key) {
		const [row] = await db
			.select()
			.from(templatesCache)
			.where(eq(templatesCache.key, key))
			.limit(1);
		return row
			? { etag: row.etag, payload: row.payload, fetchedAt: row.fetchedAt }
			: null;
	},
	async set(key, entry) {
		await db
			.insert(templatesCache)
			.values({
				key,
				etag: entry.etag,
				payload: entry.payload,
				fetchedAt: entry.fetchedAt,
			})
			.onConflictDoUpdate({
				target: templatesCache.key,
				set: {
					etag: entry.etag,
					payload: entry.payload,
					fetchedAt: entry.fetchedAt,
				},
			});
	},
};

async function github(options: { refresh?: boolean } = {}) {
	const config = getConfig();
	return createGitHubClient({
		apiUrl: config.GITHUB_API_URL,
		rawUrl: config.GITHUB_RAW_URL,
		// Settings → GitHub token, falling back to the GITHUB_TOKEN env var.
		token: await getSetting("github.token"),
		cache: dbCache,
		ttlMs: options.refresh ? 0 : config.TEMPLATE_CACHE_TTL_MS,
		timeoutMs: config.GITHUB_TIMEOUT_MS,
	});
}

/** Map engine errors to user-facing AppErrors. */
async function withTemplateErrors<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof GitHubRateLimitError) throw error;
		if (error instanceof GitHubError) {
			throw new AppError("TEMPLATE_SOURCE_ERROR", {
				reason: { $error: errorInfoOf(error) },
			});
		}
		// TemplateErrors are coded AppErrors: they pass as they are.
		throw error;
	}
}

async function fetchVersions(
	manifest: TemplateManifest,
	refresh = false,
): Promise<TemplateVersion[]> {
	const versions = await fetchRawVersions(manifest, refresh);
	return manifest.source.sort === "version"
		? [...versions].sort((a, b) => compareVersionNames(b.ref, a.ref))
		: versions;
}

async function fetchRawVersions(
	manifest: TemplateManifest,
	refresh: boolean,
): Promise<TemplateVersion[]> {
	const { repo: maybeRepo, versions, ref, path: dir, type } = manifest.source;
	if (type === "inline" || !maybeRepo) {
		return [
			{
				ref: INLINE_VERSION,
				name: INLINE_VERSION,
				publishedAt: null,
				prerelease: false,
			},
		];
	}
	const repo = maybeRepo;
	const client = await github({ refresh });
	if (versions === "branches") {
		return versionsFromBranches(await client.listBranches(repo));
	}
	if (versions === "releases") {
		return versionsFromReleases(await client.listReleases(repo));
	}
	if (versions === "tags") return versionsFromTags(await client.listTags(repo));
	return versionsFromCommits(
		await client.listCommits(repo, ref, dir === "." ? undefined : dir),
	);
}

export async function getTemplateVersions(
	templateId: string,
	options: { includePrereleases?: boolean; refresh?: boolean } = {},
): Promise<{ versions: TemplateVersion[]; defaultRef: string | null }> {
	const { manifest } = await getTemplate(templateId);
	return withTemplateErrors(async () => {
		const all = await fetchVersions(manifest, options.refresh);
		const offer = versionOffer(manifest.source);
		return {
			versions: filterVersions(all, {
				...offer,
				includePrereleases: options.includePrereleases,
			}),
			defaultRef: defaultVersion(all, offer)?.ref ?? null,
		};
	});
}

// ---------------------------------------------------------------------------
// Rendering.

async function readLocalFiles(
	dir: string,
	skip: Set<string>,
): Promise<FetchedFile[]> {
	const files: FetchedFile[] = [];
	const walk = async (current: string) => {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			const rel = path.relative(dir, full).split(path.sep).join("/");
			if (entry.isSymbolicLink() || skip.has(rel)) continue;
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) {
				const info = await stat(full);
				files.push({
					path: rel,
					content: await readFile(full),
					executable: (info.mode & 0o111) !== 0,
				});
			}
		}
	};
	await walk(dir);
	return files;
}

export type { RenderedTemplate };

/** Template files: fetched at the pinned commit, or the template's own. */
async function templateFiles(
	template: LoadedTemplate,
	client: Awaited<ReturnType<typeof github>>,
	commit: { sha: string; tree: string },
	version: string,
): Promise<{ files: FetchedFile[]; warnings: ErrorInfo[] }> {
	const { manifest, dir } = template;
	const source = manifest.source;
	const local = new Set([
		MANIFEST_FILE,
		manifest.logo,
		manifest.overlay,
		...manifest.overlays.map((item) => item.path),
	]);
	if (!source.path) {
		return { files: await readLocalFiles(dir, local), warnings: [] };
	}
	const config = getConfig();
	const fetched = await client.fetchDirectory(
		source.repo as string,
		commit.sha,
		commit.tree,
		source.path === "." ? undefined : source.path,
		includedPaths(source.include, version),
		{
			maxFiles: config.TEMPLATE_EXTRACT_MAX_FILES,
			maxBytes: config.TEMPLATE_EXTRACT_MAX_BYTES,
		},
	);
	return {
		files: fetched.files,
		warnings: fetched.skipped.map((file) =>
			coded("TEMPLATE_WARN_SKIPPED_FILE", { file }),
		),
	};
}

/** The template's compose overlay (from its own directory), if any. */
async function readOverlay(template: LoadedTemplate): Promise<string | null> {
	return readTemplateFile(template, template.manifest.overlay);
}

async function readTemplateFile(
	template: LoadedTemplate,
	relative: string,
): Promise<string | null> {
	const file = path.resolve(template.dir, relative);
	if (!file.startsWith(`${template.dir}${path.sep}`)) return null;
	return existsSync(file) ? readFile(file, "utf8") : null;
}

/** The template's version-gated overlays (`[[overlays]]`); each must exist. */
async function readVersionOverlays(
	template: LoadedTemplate,
): Promise<{ minVersion: string; content: string }[]> {
	const out: { minVersion: string; content: string }[] = [];
	for (const item of template.manifest.overlays) {
		const content = await readTemplateFile(template, item.path);
		if (content === null) {
			throw new TemplateError("TEMPLATE_FILE_MISSING", { file: item.path });
		}
		out.push({ minVersion: item.min_version, content });
	}
	return out;
}

function renderSettings(): RenderSettings {
	const config = getConfig();
	return {
		appsRoot: hostPaths(config).apps,
		traefikDynamicDir: hostPaths(config).traefikDynamic,
		network: config.NITROBASE_NETWORK,
		certResolver: config.TRAEFIK_CERT_RESOLVER,
		hasher: bcryptHasher(config.TRAEFIK_BASIC_AUTH_COST),
		instanceId: currentInstanceId() ?? undefined,
		defaultRestart: defaultRestartOf(config.APP_DEFAULT_RESTART),
	};
}

/**
 * Render a template for an app: pin the version to a commit SHA, fetch the
 * files, resolve variables, transform compose and generate Traefik config.
 * Pure with respect to servers: nothing is written anywhere (Phase D deploys).
 * Custom-compose apps pass their `custom` spec instead of a version.
 */
export async function renderTemplate(
	input: Omit<
		RenderInput,
		| "manifest"
		| "files"
		| "overlay"
		| "fetchWarnings"
		| "version"
		| "commitSha"
		| "appId"
		| "domain"
	> & {
		templateId: string;
		version?: string;
		domain?: string;
		appId?: string;
		/** Redeploy: reuse the exact commit of the last deploy. */
		commitSha?: string;
		/**
		 * Owner-defined sources (custom compose, git): the files and manifest
		 * their driver renders instead of an upstream version.
		 */
		source?: Pick<
			RenderInput,
			| "manifest"
			| "files"
			| "overlay"
			| "extraDefaults"
			| "version"
			| "commitSha"
		>;
	},
): Promise<RenderedTemplate> {
	const template = await getTemplate(input.templateId);
	const { manifest } = template;
	return withTemplateErrors(async () => {
		if (!input.domain) throw new TemplateError("TEMPLATE_DOMAIN_REQUIRED");
		const appId = input.appId ?? randomUUID();
		const {
			source: owned,
			templateId: _id,
			commitSha: pinned,
			...rest
		} = input;
		if (manifest.source.type !== "github") {
			if (!owned) {
				throw new TemplateError(
					manifest.source.type === "inline"
						? "TEMPLATE_COMPOSE_REQUIRED"
						: "TEMPLATE_NOTHING_TO_DEPLOY",
				);
			}
			return renderFromFiles(
				{ ...rest, ...owned, appId, domain: input.domain },
				renderSettings(),
			);
		}
		const client = await github();
		const source = manifest.source;
		const repo = source.repo as string;

		let version = input.version;
		if (!version) {
			const all = await fetchVersions(manifest);
			version = defaultVersion(all, versionOffer(manifest.source))?.ref;
			if (!version) throw new TemplateError("TEMPLATE_NO_STABLE_VERSION");
		}
		if (!REF_PATTERN.test(version)) {
			throw new TemplateError("TEMPLATE_VERSION_INVALID", { version });
		}
		// Enforced here too, so a request naming a version the picker hides
		// (filtered out, or below `min_version`) is refused. A redeploy of
		// the commit an app already runs keeps working if the floor was
		// raised later.
		if (
			source.versions !== "commits" &&
			!isVersionOffered(version, {
				filter: source.version_filter,
				minVersion: pinned ? undefined : source.min_version,
			})
		) {
			throw new TemplateError("TEMPLATE_VERSION_NOT_OFFERED", { version });
		}
		// A commit SHA is no version of a tags/releases/branches source (a
		// redeploy pins its commit separately); see isVersionRefForSource.
		if (!pinned && !isVersionRefForSource(version, source)) {
			throw new TemplateError("TEMPLATE_VERSION_NOT_OFFERED", { version });
		}

		// Pin once: every file comes from this exact commit.
		if (pinned && !/^[0-9a-f]{40}$/.test(pinned)) {
			throw new TemplateError("TEMPLATE_COMMIT_INVALID");
		}
		const commit = await client.resolveCommit(repo, pinned ?? version);
		const { files, warnings } = await templateFiles(
			template,
			client,
			commit,
			version,
		);
		const overlay = await readOverlay(template);
		const versionOverlays = await readVersionOverlays(template);
		const renderedVersion = version;
		const domain = input.domain;
		const renderFiles = () =>
			renderFromFiles(
				{
					...rest,
					manifest,
					files,
					overlay,
					versionOverlays,
					fetchWarnings: warnings,
					version: renderedVersion,
					commitSha: commit.sha,
					appId,
					domain,
				},
				renderSettings(),
			);
		// With `source.path` the compose is upstream's at `version`.
		const rendered = source.path
			? withUpstreamRefusals(version, renderFiles)
			: renderFiles();
		// A bind source upstream has as a file but that was not fetched
		// would become an empty directory on the server: refused here. The
		// listing is only fetched when a candidate is named like a file.
		const unwritten = unwrittenBindSources({
			...rendered,
			dataPaths: declaredDataPaths(manifest),
		});
		if (source.path && needsUpstreamListing(unwritten)) {
			assertBindSourcesFetched(
				unwritten,
				await client.listFiles(
					repo,
					commit.tree,
					source.path === "." ? undefined : source.path,
					unwritten.map((bind) => bind.path),
				),
			);
		}
		return rendered;
	});
}

/**
 * Dry render of a new app from the deploy wizard's choices: the render its
 * first deploy runs (version, policy, transform), nothing written
 * anywhere. Fetched files come from the template cache, so a pre-flight
 * followed by the deploy fetches them once. Only templates rendered from
 * upstream versions; the other sources validate their own input (custom
 * compose analysis, git build, database engine). Null when not applicable.
 */
export async function dryRenderNewApp(input: {
	templateId: string;
	version?: string;
	appId?: string;
	name?: string;
	/** Empty or invalid: a placeholder host (the domain is checked apart). */
	domain?: string;
	inputs?: Record<string, string>;
}): Promise<RenderedTemplate | null> {
	const { manifest } = await getTemplate(input.templateId);
	if (manifest.source.type !== "github") return null;
	const appId = input.appId ?? randomUUID();
	let domain = `${appFolderName(manifest.id, appId)}.invalid`;
	if (input.domain) {
		try {
			domain = assertHostname(input.domain);
		} catch {
			// Reported by the domain check.
		}
	}
	return renderTemplate({
		templateId: input.templateId,
		version: input.version,
		appId,
		appName: input.name || manifest.name,
		domain,
		overrides: Object.fromEntries(
			Object.entries(input.inputs ?? {}).filter(([, value]) => value !== ""),
		),
	});
}

// ---------------------------------------------------------------------------
// Custom compose

/** Analyse a pasted compose file (services, ports, volumes, policy). */
export function analyzeCustomComposeText(
	compose: string,
	env: string,
	templateId: string,
): CustomComposeAnalysis {
	const config = getConfig();
	const folder = appFolderName(templateId, "00000000");
	return analyzeCustomCompose(compose, env, {
		folder,
		appRoot: `${hostPaths(config).apps}/${folder}`,
		network: config.NITROBASE_NETWORK,
		defaultRestart: renderSettings().defaultRestart,
	});
}

/**
 * Validate a custom-compose spec before it is stored: the compose passes
 * the policy, routed services/ports and backup volumes exist, env parses.
 */
export function assertCustomSpec(
	spec: CustomComposeSpec,
	templateId: string,
): CustomComposeAnalysis {
	const analysis = analyzeCustomComposeText(spec.compose, spec.env, templateId);
	if (analysis.error) throw templateError(analysis.error);
	const services = new Set(analysis.services.map((service) => service.name));
	const seen = new Set<string>();
	for (const route of spec.routes) {
		if (!services.has(route.service)) {
			throw new AppError("CUSTOM_ROUTE_SERVICE_MISSING", {
				service: route.service,
			});
		}
		const key = `${route.service}:${route.port}`;
		if (seen.has(key)) throw new AppError("CUSTOM_ROUTE_TWICE", { route: key });
		seen.add(key);
	}
	for (const volume of spec.backupVolumes) {
		if (!analysis.volumes.includes(volume)) {
			throw new AppError("CUSTOM_VOLUME_MISSING", { volume });
		}
	}
	for (const name of Object.keys(parseEnvFile(spec.env))) {
		if (!ENV_NAME_PATTERN.test(name) || RESERVED_ENV_PATTERN.test(name)) {
			throw new AppError("VARIABLE_NAME_INVALID", { name });
		}
	}
	return analysis;
}
