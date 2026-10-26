import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getConfig, hostPaths } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { db } from "#/db/index.ts";
import { appGitSources, appReleases, gitCredentials } from "#/db/schema/git.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import type { JobContext } from "#/features/deployments/deployments.server.ts";
import { requireInstanceId } from "#/features/settings/instance-identity.server.ts";
import { clip } from "#/libs/format.ts";
import type { Executor } from "#/server/services/executor.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import {
	detectBuilder,
	effectiveBuilder,
} from "#/server/services/git/builders.ts";
import {
	assertImageTag,
	BUILDX_MISSING_EXIT,
	builderLimitsCommand,
	buildxCommand,
	CLONE_SCRIPT,
	type CloneContainerOptions,
	type CloneOutput,
	DOCKERFILE_SYMLINK_EXIT,
	ensureBuilderCommand,
	ensureRailpackToolsCommand,
	FINALIZE_SCRIPT,
	gitContainerCommand,
	type HostPin,
	imageAppLabelCommand,
	imageLabels,
	LS_REMOTE_SCRIPT,
	parseCloneOutput,
	parseLsRemote,
	parseProbeOutput,
	planHasSecretValue,
	pruneBuildCacheCommand,
	type RepoProbe,
	railpackPrepareCommand,
	railpackToolsImage,
	relabelCommand,
	SUBDIR_ESCAPE_EXIT,
	SUBDIR_MISSING_EXIT,
	staticDockerfile,
} from "#/server/services/git/commands.ts";
import { gitImageTag } from "#/server/services/git/compose.ts";
import {
	type GitUrl,
	GitUrlError,
	gitPort,
	isRelativeSubmoduleUrl,
	parseGitUrl,
	resolveGitHost,
} from "#/server/services/git/url.ts";
import { createSecretMasker } from "#/server/services/tasks/commands.ts";
import { decrypt } from "#/utils/crypto.ts";
import { AppError, commandError, type DetailErrorCode } from "#/utils/error.ts";
import type {
	BuilderDetection,
	BuilderId,
	BuildSettings,
	GitSource,
} from "./schema";

/**
 * Clone and build on the app's server (R2 M1). Runs inside jobs that hold
 * the server lock, except `inspectOnServer` (wizard check: a throwaway
 * folder under `git-inspect/`, removed afterwards).
 *
 * Layout of an app's build folder (`<app>/build/`): `known/known_hosts`
 * (SSH host keys, trust on first use) and one `run-<job>/` per build with
 * `auth/` (0600 credential files), `secrets/` (0600 BuildKit secret files),
 * `src/` (the checkout) and `plan/` (Railpack). The run folder is removed
 * when the build ends and any left-over one at the next build.
 */

export type GitSourceRow = typeof appGitSources.$inferSelect;
type CredentialRow = typeof gitCredentials.$inferSelect;

export function normalizeSubdir(subdir: string): string {
	return subdir
		.split("/")
		.filter((part) => part && part !== ".")
		.join("/");
}

/** Map URL problems to user-facing errors. */
function gitUrlAppError(error: unknown, host: string): never {
	if (error instanceof GitUrlError) {
		switch (error.reason) {
			case "protocol":
				throw new AppError("GIT_URL_PROTOCOL");
			case "credentials":
				throw new AppError("GIT_URL_CREDENTIALS");
			case "private":
				throw new AppError("GIT_URL_PRIVATE", { host });
			case "unresolved":
				throw new AppError("GIT_URL_UNRESOLVED", { host });
			default:
				throw new AppError("GIT_URL_INVALID");
		}
	}
	throw error;
}

/** Parse + SSRF-check a source's URL; the address the clone is pinned to. */
export async function checkedGitUrl(
	source: Pick<GitSource, "repoUrl" | "allowPrivateHost">,
): Promise<{ url: GitUrl; pinnedAddress: string | null }> {
	let url: GitUrl;
	try {
		url = parseGitUrl(source.repoUrl, {
			allowPrivate: source.allowPrivateHost,
		});
	} catch (error) {
		gitUrlAppError(error, "");
	}
	try {
		const { address } = await resolveGitHost(url, {
			allowPrivate: source.allowPrivateHost,
		});
		return { url, pinnedAddress: address };
	} catch (error) {
		gitUrlAppError(error, url.host);
	}
}

interface CredentialFiles {
	kind: "none" | "deploy_key" | "token";
	files: { name: string; content: string }[];
}

function credentialFiles(credential: CredentialRow | null): CredentialFiles {
	if (!credential) return { kind: "none", files: [] };
	const secret = decrypt(credential.secretEncrypted);
	if (credential.kind === "deploy_key") {
		return {
			kind: "deploy_key",
			files: [
				{
					name: "key",
					content: secret.endsWith("\n") ? secret : `${secret}\n`,
				},
			],
		};
	}
	return {
		kind: "token",
		files: [
			{ name: "username", content: `${credential.username ?? "git"}\n` },
			{ name: "token", content: `${secret}\n` },
		],
	};
}

/** mkdir -p each folder and make sure none goes through a symlink. */
function makeDirsScript(dirs: string[]): string {
	return dirs
		.map(
			(dir) =>
				`mkdir -p -- ${q(dir)} && [ "$(realpath -- ${q(dir)})" = ${q(dir)} ] || { echo "unsafe folder ${dir}" >&2; exit 93; }`,
		)
		.join("\n");
}

/** Replace secret values in a finished text (error details). */
function maskSecrets(text: string, secrets: string[]): string {
	const masker = createSecretMasker(secrets);
	return masker.push(text) + masker.flush();
}

type ExecError = AppError & { exitCode?: number; detail?: string };

async function exec(
	executor: Executor,
	command: string,
	failure: DetailErrorCode,
	options: {
		ctx?: JobContext;
		timeoutMs?: number;
		log?: boolean;
		/** Values never written to the log or an error (build secrets, token). */
		secrets?: string[];
	} = {},
): Promise<string> {
	const ctx = options.ctx;
	const secrets = options.secrets ?? [];
	const out = createSecretMasker(secrets);
	const err = createSecretMasker(secrets);
	const emit = (text: string) => {
		if (text && ctx) ctx.log(text);
	};
	const result = await executor.exec(command, {
		timeoutMs: options.timeoutMs,
		signal: ctx?.signal,
		onStdout: options.log && ctx ? (chunk) => emit(out.push(chunk)) : undefined,
		onStderr: options.log && ctx ? (chunk) => emit(err.push(chunk)) : undefined,
	});
	if (options.log) {
		emit(out.flush());
		emit(err.flush());
	}
	if (result.exitCode !== 0) {
		const detail = maskSecrets(
			(result.stderr || result.stdout || `exit ${result.exitCode}`)
				.trim()
				.split("\n")
				.slice(-6)
				.join("\n"),
			secrets,
		);
		const error = commandError(failure, detail) as ExecError;
		error.exitCode = result.exitCode;
		error.detail = detail;
		throw error;
	}
	return result.stdout;
}

interface Checkout {
	clone: CloneOutput;
	probe: RepoProbe;
}

const pinOf = (url: GitUrl, address: string | null): HostPin[] =>
	address ? [{ host: url.host, port: gitPort(url), address }] : [];

/** Credential material that must never appear in logs. */
function credentialSecrets(files: CredentialFiles): string[] {
	return files.files
		.filter((file) => file.name !== "username")
		.flatMap((file) => [file.content.trim(), ...file.content.split("\n")])
		.map((value) => value.trim())
		.filter((value) => value.length >= 16);
}

/**
 * Clone `source` into `<runDir>/src` at `commitSha` (or the branch tip),
 * check submodule URLs (same rules as the repository URL; SSH and, with a
 * token, any submodule must be on the repository's own host so no
 * credential reaches another host) and probe the build folder.
 */
async function checkout(input: {
	executor: Executor;
	runDir: string;
	knownDir: string;
	source: Pick<
		GitSourceRow,
		"repoUrl" | "branch" | "subdir" | "submodules" | "allowPrivateHost"
	>;
	credential: CredentialRow | null;
	commitSha?: string;
	dockerfilePath: string;
	timeoutMs: number;
	ctx?: JobContext;
}): Promise<Checkout> {
	const config = getConfig();
	const { executor, runDir, ctx } = input;
	const { url, pinnedAddress } = await checkedGitUrl(input.source);
	const creds = credentialFiles(input.credential);
	const secrets = credentialSecrets(creds);
	const authDir = `${runDir}/auth`;
	const workspace = `${runDir}/src`;
	await exec(
		executor,
		makeDirsScript([workspace, input.knownDir, authDir]),
		"GIT_BUILD_DIR_FAILED",
	);
	await ctx?.setWorkDir?.(runDir);
	for (const file of creds.files) {
		await executor.upload(file.content, `${authDir}/${file.name}`, "0600");
	}
	const container = (
		protocols: GitUrl["protocol"][],
		pins: HostPin[],
	): CloneContainerOptions => ({
		image: config.GIT_IMAGE,
		workspace,
		url,
		protocols,
		pins,
		auth: {
			authDir: creds.kind === "none" ? null : authDir,
			kind: creds.kind,
			knownHostsDir: input.knownDir,
		},
		memoryMb: config.GIT_CLONE_MEMORY_MB,
	});
	const protocols: GitUrl["protocol"][] = [url.protocol];
	const pins = pinOf(url, pinnedAddress);
	if (input.commitSha) {
		ctx?.event("build.fetching_commit", {
			url: url.url,
			commit: input.commitSha.slice(0, 12),
		});
	} else {
		ctx?.event("build.fetching_branch", {
			url: url.url,
			branch: input.source.branch,
		});
	}
	let output: string;
	try {
		output = await exec(
			executor,
			gitContainerCommand(container(protocols, pins), CLONE_SCRIPT, [
				url.url,
				input.source.branch,
				input.commitSha ?? "",
			]),
			"GIT_FETCH_FAILED",
			{ ctx, timeoutMs: input.timeoutMs, secrets },
		);
	} catch (error) {
		throw new AppError("GIT_CLONE_FAILED", {
			detail: clip(
				(error as ExecError).detail ?? String(error),
				TEXT_LIMITS.errorDetail,
			),
		});
	}
	const clone = parseCloneOutput(output);
	ctx?.event("build.commit", {
		commit: clone.commitSha.slice(0, 12),
		author: clone.author || "?",
		message: clone.message,
	});
	let withSubmodules = false;
	if (input.source.submodules && clone.submodules.length) {
		for (const submodule of clone.submodules) {
			if (isRelativeSubmoduleUrl(submodule)) continue;
			// Same rules as the repository itself (SSRF, protocols).
			const checked = await checkedGitUrl({
				repoUrl: submodule,
				allowPrivateHost: input.source.allowPrivateHost,
			});
			const otherHost = checked.url.host !== url.host;
			if (
				otherHost &&
				(checked.url.protocol === "ssh" || creds.kind === "token")
			) {
				throw new AppError("GIT_SUBMODULE_HOST", { host: checked.url.host });
			}
			protocols.push(checked.url.protocol);
			if (checked.url.protocol !== "ssh") {
				pins.push(...pinOf(checked.url, checked.pinnedAddress));
			}
		}
		withSubmodules = true;
		ctx?.event("build.submodules", { count: clone.submodules.length });
	} else if (clone.submodules.length) {
		ctx?.event("build.submodules_skipped");
	}
	const folder = normalizeSubdir(input.source.subdir);
	let probeOutput: string;
	try {
		probeOutput = await exec(
			executor,
			gitContainerCommand(container(protocols, pins), FINALIZE_SCRIPT, [
				withSubmodules ? "1" : "0",
				folder,
				input.dockerfilePath,
			]),
			"GIT_READ_FAILED",
			{ ctx, timeoutMs: input.timeoutMs, secrets },
		);
	} catch (error) {
		const code = (error as ExecError).exitCode;
		if (code === SUBDIR_MISSING_EXIT) {
			throw new AppError("GIT_SUBDIR_NOT_FOUND", { folder });
		}
		if (code === SUBDIR_ESCAPE_EXIT) {
			throw new AppError("GIT_SUBDIR_NOT_REAL", { folder });
		}
		if (code === DOCKERFILE_SYMLINK_EXIT) {
			throw new AppError("GIT_DOCKERFILE_SYMLINK", {
				path: input.dockerfilePath,
			});
		}
		throw new AppError("GIT_CLONE_FAILED", {
			detail: clip(
				(error as ExecError).detail ?? String(error),
				TEXT_LIMITS.errorDetail,
			),
		});
	}
	return { clone, probe: parseProbeOutput(probeOutput) };
}

/**
 * Wizard check: clone the branch tip in a throwaway folder on `executor`'s
 * server, detect the builder, remove the folder. Nothing is kept (host
 * keys seen here are trusted again at the first build).
 */
export async function inspectOnServer(input: {
	executor: Executor;
	source: GitSource;
	credential: CredentialRow | null;
	build: BuildSettings;
}): Promise<{ checkout: Checkout; detection: BuilderDetection }> {
	const config = getConfig();
	const root = `${hostPaths(config).gitInspect}/${randomUUID()}`;
	try {
		const result = await checkout({
			executor: input.executor,
			runDir: root,
			knownDir: `${root}/known`,
			source: input.source,
			credential: input.credential,
			dockerfilePath: input.build.dockerfile.path,
			timeoutMs: config.GIT_INSPECT_TIMEOUT_MS,
		});
		return {
			checkout: result,
			detection: detectBuilder(result.probe, input.build),
		};
	} finally {
		await input.executor
			.exec(`rm -rf -- ${q(root)}`, {
				timeoutMs: config.GIT_CLEANUP_TIMEOUT_MS,
			})
			.catch(() => {});
	}
}

interface BuildLimitsResolved {
	memoryMb: number;
	cpus: number;
	timeoutSeconds: number;
}

function resolvedBuildLimits(build: BuildSettings): BuildLimitsResolved {
	const config = getConfig();
	return {
		memoryMb: build.limits.memoryMb ?? config.BUILD_MEMORY_MB,
		cpus: build.limits.cpus ?? config.BUILD_CPUS,
		timeoutSeconds: Math.min(
			build.limits.timeoutSeconds ?? config.BUILD_TIMEOUT_SECONDS,
			config.BUILD_MAX_TIMEOUT_SECONDS,
		),
	};
}

export function readBuildSecrets(
	row: Pick<GitSourceRow, "buildSecretsEncrypted">,
): Record<string, string> {
	if (!row.buildSecretsEncrypted) return {};
	return JSON.parse(decrypt(row.buildSecretsEncrypted)) as Record<
		string,
		string
	>;
}

async function sourceCredential(
	row: GitSourceRow,
): Promise<CredentialRow | null> {
	if (row.auth === "none" || !row.credentialId) return null;
	const [credential] = await db
		.select()
		.from(gitCredentials)
		.where(
			and(
				eq(gitCredentials.id, row.credentialId),
				eq(gitCredentials.appId, row.appId),
			),
		)
		.limit(1);
	return credential ?? null;
}

export async function getGitSourceRow(appId: string): Promise<GitSourceRow> {
	const [row] = await db
		.select()
		.from(appGitSources)
		.where(eq(appGitSources.appId, appId))
		.limit(1);
	if (!row) throw new AppError("GIT_NOT_GIT_APP");
	return row;
}

function appBuildDir(app: Pick<AppRow, "folder">): string {
	return `${hostPaths().apps}/${app.folder}/build`;
}

/** Commit the build will produce (clone result), recorded as a release. */
async function upsertRelease(
	app: AppRow,
	clone: CloneOutput,
	values: Partial<typeof appReleases.$inferInsert>,
): Promise<string> {
	const [row] = await db
		.insert(appReleases)
		.values({
			appId: app.id,
			commitSha: clone.commitSha,
			message: clone.message,
			author: clone.author,
			committedAt: clone.committedAt ? new Date(clone.committedAt) : null,
			imageTag: gitImageTag(app.folder, clone.commitSha),
			status: "building",
			...values,
		})
		.onConflictDoUpdate({
			target: [appReleases.appId, appReleases.commitSha],
			set: {
				message: clone.message,
				author: clone.author,
				status: "building",
				updatedAt: new Date(),
				...values,
			},
		})
		.returning({ id: appReleases.id });
	return row.id;
}

/**
 * Whether `tag` exists on the server *and* was built for this app (its
 * `nitrobase.app` label): a same-named image of anything else is rebuilt.
 */
export async function ownImageExists(
	executor: Executor,
	tag: string,
	appId: string,
): Promise<boolean> {
	const result = await executor.exec(imageAppLabelCommand(tag));
	return result.exitCode === 0 && result.stdout.trim() === appId;
}

/**
 * Build the app's image at `commitSha` (default: the branch tip) on the
 * server of `executor`, unless this app's image of that commit exists.
 * Runs under the app's lock only: it never touches the running app.
 */
export async function buildCommit(input: {
	executor: Executor;
	app: AppRow;
	commitSha?: string;
	ctx: JobContext;
}): Promise<{ commitSha: string; built: boolean }> {
	const { executor, app, ctx } = input;
	const config = getConfig();
	const source = await getGitSourceRow(app.id);
	const credential = await sourceCredential(source);
	if (source.auth !== "none" && !credential) {
		throw new AppError("GIT_CREDENTIAL_REQUIRED");
	}
	if (input.commitSha) {
		const tag = gitImageTag(app.folder, input.commitSha);
		if (await ownImageExists(executor, tag, app.id)) {
			ctx.event("build.already_built", { image: tag });
			return { commitSha: input.commitSha, built: false };
		}
	}
	const buildDir = appBuildDir(app);
	const runDir = `${buildDir}/run-${ctx.deploymentId.slice(0, 8)}`;
	const limits = resolvedBuildLimits(source.build);
	const builder = { name: config.BUILDX_BUILDER, image: config.BUILDKIT_IMAGE };
	const started = Date.now();
	const secrets = readBuildSecrets(source);
	const masked = [
		...Object.values(secrets),
		...credentialSecrets(credentialFiles(credential)),
	];
	let releaseId: string | null = null;
	// Earlier runs interrupted by a crash leave their folder behind.
	await exec(
		executor,
		`find ${q(buildDir)} -maxdepth 1 -name 'run-*' -exec rm -rf {} + 2>/dev/null; true`,
		"GIT_BUILD_CLEAN_FAILED",
	);
	try {
		const { clone, probe } = await checkout({
			executor,
			runDir,
			knownDir: `${buildDir}/known`,
			source,
			credential,
			commitSha: input.commitSha,
			dockerfilePath: source.build.dockerfile.path,
			timeoutMs: config.GIT_CLONE_TIMEOUT_MS,
			ctx,
		});
		const tag = gitImageTag(app.folder, clone.commitSha);
		if (!input.commitSha && (await ownImageExists(executor, tag, app.id))) {
			ctx.event("build.already_built", { image: tag });
			await db
				.update(appReleases)
				.set({ status: "ready", updatedAt: new Date() })
				.where(
					and(
						eq(appReleases.appId, app.id),
						eq(appReleases.commitSha, clone.commitSha),
					),
				);
			return { commitSha: clone.commitSha, built: false };
		}
		const detection = detectBuilder(probe, source.build);
		const kind = effectiveBuilder(source.build, detection);
		await db
			.update(appGitSources)
			.set({ detectedBuilder: detection.builder })
			.where(eq(appGitSources.appId, app.id));
		if (!kind) throw new AppError("GIT_NO_BUILDER");
		if (source.build.builder === "auto") {
			ctx.event("build.builder_detected", {
				builder: kind,
				detected: describeDetection(detection),
			});
		} else {
			ctx.event("build.builder", { builder: kind });
		}
		releaseId = await upsertRelease(app, clone, {
			builder: kind,
			buildDeploymentId: ctx.deploymentId,
		});

		ctx.event("build.buildkit", {
			memory: { $bytes: limits.memoryMb * 1024 * 1024 },
			cpus: limits.cpus,
			timeout: { $ms: limits.timeoutSeconds * 1000 },
		});
		try {
			await exec(
				executor,
				ensureBuilderCommand(builder),
				"GIT_BUILDKIT_FAILED",
				{
					ctx,
					timeoutMs: config.BUILDKIT_SETUP_TIMEOUT_MS,
				},
			);
		} catch (error) {
			if ((error as ExecError).exitCode === BUILDX_MISSING_EXIT) {
				throw new AppError("GIT_BUILDX_MISSING");
			}
			throw error;
		}
		await exec(
			executor,
			builderLimitsCommand(builder, limits),
			"GIT_BUILD_LIMITS_FAILED",
			{ ctx },
		);

		const secretFiles: Record<string, string> = {};
		for (const [name, value] of Object.entries(secrets)) {
			const file = `${runDir}/secrets/${name}`;
			await executor.upload(value, file, "0600");
			secretFiles[name] = file;
		}
		const subdir = normalizeSubdir(source.subdir);
		const context = subdir ? `${runDir}/src/${subdir}` : `${runDir}/src`;
		const labels = imageLabels({
			appId: app.id,
			instanceId: await requireInstanceId(),
			commitSha: clone.commitSha,
		});
		const steps = await builderSteps({
			kind,
			executor,
			runDir,
			context,
			tag,
			labels,
			settings: source.build,
			detection,
			secrets,
			secretFiles,
		});
		ctx.event("build.building", { image: tag });
		const deadline = started + limits.timeoutSeconds * 1000;
		for (const step of steps) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new AppError("GIT_BUILD_TIMEOUT", {
					seconds: limits.timeoutSeconds,
				});
			}
			if (typeof step === "function") {
				await step();
				continue;
			}
			try {
				await exec(executor, step, "GIT_BUILD_FAILED", {
					ctx,
					log: true,
					timeoutMs: remaining,
					secrets: masked,
				});
			} catch (error) {
				if (Date.now() >= deadline - 1000) {
					throw new AppError("GIT_BUILD_TIMEOUT", {
						seconds: limits.timeoutSeconds,
					});
				}
				throw error;
			}
		}
		await db
			.update(appReleases)
			.set({
				status: "ready",
				buildDurationMs: Date.now() - started,
				updatedAt: new Date(),
			})
			.where(eq(appReleases.id, releaseId));
		ctx.event("build.built", {
			image: tag,
			duration: { $ms: Date.now() - started },
		});
		return { commitSha: clone.commitSha, built: true };
	} catch (error) {
		if (releaseId) {
			await db
				.update(appReleases)
				.set({
					status: "failed",
					buildDurationMs: Date.now() - started,
					updatedAt: new Date(),
				})
				.where(eq(appReleases.id, releaseId));
		}
		if (ctx.signal?.aborted) throw new AppError("JOB_CANCELLED");
		throw error;
	} finally {
		await executor
			.exec(`rm -rf -- ${q(runDir)}`, {
				timeoutMs: config.BUILD_CLEANUP_TIMEOUT_MS,
			})
			.catch(() => {});
		await ctx.setWorkDir?.(null).catch(() => {});
		await executor
			.exec(pruneBuildCacheCommand(builder, config.BUILD_CACHE_KEEP_MB), {
				timeoutMs: config.BUILD_CLEANUP_TIMEOUT_MS,
			})
			.catch(() => {});
	}
}

function describeDetection(detection: BuilderDetection): string {
	const reason = detection.reason;
	switch (reason.code) {
		case "dockerfile":
			return reason.path;
		case "static_framework":
			return reason.framework;
		case "static_html":
			return "index.html";
		case "railpack":
			return reason.marker;
		default:
			return "-";
	}
}

/** A shell command, or a check run in the panel between commands. */
type BuildStep = string | (() => Promise<void>);

/** Steps of one build, per builder. */
async function builderSteps(input: {
	kind: BuilderId;
	executor: Executor;
	runDir: string;
	context: string;
	tag: string;
	labels: Record<string, string>;
	settings: BuildSettings;
	detection: BuilderDetection;
	secrets: Record<string, string>;
	secretFiles: Record<string, string>;
}): Promise<BuildStep[]> {
	const config = getConfig();
	const builder = { name: config.BUILDX_BUILDER, image: config.BUILDKIT_IMAGE };
	const base = {
		builder,
		tag: input.tag,
		context: input.context,
		labels: input.labels,
		secrets: input.secretFiles,
	};
	if (input.kind === "dockerfile") {
		return [
			buildxCommand({
				...base,
				// The finalize step refused any symlink on this path.
				file: `${input.context}/${input.settings.dockerfile.path}`,
				target: input.settings.dockerfile.target,
				buildArgs: input.settings.dockerfile.buildArgs,
			}),
		];
	}
	if (input.kind === "static") {
		const auto = input.settings.builder === "auto";
		const file = `${input.runDir}/static.Dockerfile`;
		await input.executor.upload(
			staticDockerfile({
				buildImage:
					input.settings.static.buildImage ?? config.STATIC_BUILD_IMAGE,
				serveImage: config.STATIC_SERVE_IMAGE,
				buildCommand: auto
					? (input.detection.buildCommand ?? "")
					: input.settings.static.buildCommand,
				outputDir: auto
					? (input.detection.outputDir ?? ".")
					: input.settings.static.outputDir,
				secretNames: Object.keys(input.secrets),
			}),
			file,
			"0644",
		);
		return [buildxCommand({ ...base, file, buildArgs: {} })];
	}
	// Railpack: CLI image (checksum-verified), plan (secrets by name only,
	// checked), frontend build, labels.
	const tools = {
		image: railpackToolsImage(config.RAILPACK_VERSION),
		baseImage: config.RAILPACK_BASE_IMAGE,
		version: config.RAILPACK_VERSION,
		downloadUrl: config.RAILPACK_DOWNLOAD_URL,
		sha256: {
			amd64: config.RAILPACK_SHA256_AMD64,
			arm64: config.RAILPACK_SHA256_ARM64,
		},
	};
	const planDir = `${input.runDir}/plan`;
	const planFile = `${planDir}/railpack-plan.json`;
	const secretsHash = createHash("sha256")
		.update(JSON.stringify(Object.entries(input.secrets).sort()))
		.digest("hex");
	const raw = assertImageTag(`${input.tag}-raw`);
	return [
		`mkdir -p -- ${q(planDir)}`,
		ensureRailpackToolsCommand(tools),
		railpackPrepareCommand({
			toolsImage: tools.image,
			context: input.context,
			planDir,
			secretNames: Object.keys(input.secrets),
		}),
		async () => {
			const plan = await input.executor.readFile(planFile);
			if (planHasSecretValue(plan, Object.values(input.secrets))) {
				throw new AppError("GIT_PLAN_HAS_SECRET");
			}
		},
		buildxCommand({
			...base,
			tag: raw,
			file: planFile,
			labels: {},
			buildArgs: {
				BUILDKIT_SYNTAX: config.RAILPACK_FRONTEND_IMAGE,
				"secrets-hash": secretsHash,
			},
		}),
		relabelCommand(raw, input.tag, input.labels),
	];
}

/**
 * Tip of the app's branch on its remote (update check), asked from the
 * app's server with the app's credential, URL rules, pinned address and
 * known hosts: `git ls-remote` in the same locked-down container as a
 * clone, in a throwaway folder.
 */
export async function remoteBranchTip(
	executor: Executor,
	app: AppRow,
): Promise<{ sha: string | null; branch: string; repoUrl: string }> {
	const config = getConfig();
	const source = await getGitSourceRow(app.id);
	const credential = await sourceCredential(source);
	if (source.auth !== "none" && !credential) {
		throw new AppError("GIT_CREDENTIAL_REQUIRED");
	}
	const { url, pinnedAddress } = await checkedGitUrl(source);
	const creds = credentialFiles(credential);
	const buildDir = appBuildDir(app);
	const runDir = `${buildDir}/tip-${randomUUID().slice(0, 8)}`;
	// Like a checkout: the container sees only `src` (empty), never the
	// credential folder next to it.
	const workspace = `${runDir}/src`;
	const authDir = `${runDir}/auth`;
	const knownDir = `${buildDir}/known`;
	try {
		await exec(
			executor,
			makeDirsScript([workspace, knownDir, authDir]),
			"GIT_BUILD_DIR_FAILED",
		);
		for (const file of creds.files) {
			await executor.upload(file.content, `${authDir}/${file.name}`, "0600");
		}
		const output = await exec(
			executor,
			gitContainerCommand(
				{
					image: config.GIT_IMAGE,
					workspace,
					url,
					protocols: [url.protocol],
					pins: pinOf(url, pinnedAddress),
					auth: {
						authDir: creds.kind === "none" ? null : authDir,
						kind: creds.kind,
						knownHostsDir: knownDir,
					},
					memoryMb: config.GIT_CLONE_MEMORY_MB,
				},
				LS_REMOTE_SCRIPT,
				[url.url, source.branch],
			),
			"GIT_LS_REMOTE_FAILED",
			{
				timeoutMs: config.GIT_INSPECT_TIMEOUT_MS,
				secrets: credentialSecrets(creds),
			},
		);
		return {
			sha: parseLsRemote(output, source.branch),
			branch: source.branch,
			repoUrl: source.repoUrl,
		};
	} finally {
		await executor
			.exec(`rm -rf -- ${q(runDir)}`, {
				timeoutMs: getConfig().GIT_CLEANUP_TIMEOUT_MS,
			})
			.catch(() => {});
	}
}
