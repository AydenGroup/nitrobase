import path from "node:path";
import {
	DOCKER_LABELS,
	labelFilter,
	labelValueTemplate,
	resourceName,
} from "#/config/identifiers.ts";
import { APP_ID } from "#/config/shared.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { clip } from "#/libs/format.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { AppError, internalError } from "#/utils/error.ts";
import type { GitUrl } from "./url";

/**
 * Shell commands of git apps (pure; exact strings are unit-tested). Every
 * dynamic value is validated by the caller's schemas and shell-quoted here;
 * repository values reach the clone script as positional parameters, never
 * spliced into its text.
 *
 * Clones run in a throwaway container (GIT_IMAGE) on the app's server:
 * no host mounts besides the checkout folder, the credential folder
 * (read-only) and the known_hosts folder; no capabilities, no new
 * privileges, no system/global git config, no credential helper, hooks
 * disabled, only the protocols of the URL allowed, redirects refused.
 */

/** Output markers of the clone/probe scripts (one per line). */
const MARK = "@@SB";

interface GitAuthMounts {
	/** Host folder with `key` (deploy key) or `username` + `token` (0600). */
	authDir: string | null;
	kind: "none" | "deploy_key" | "token";
	/** Host folder holding the app's `known_hosts` (TOFU for SSH hosts). */
	knownHostsDir: string;
}

/** A checked host and the address its connections are pinned to. */
export interface HostPin {
	host: string;
	port: number;
	address: string;
}

export interface CloneContainerOptions {
	image: string;
	/** Host folder mounted at /workspace (the checkout). */
	workspace: string;
	url: GitUrl;
	/** Protocols git may use (the repository's, plus checked submodules'). */
	protocols: GitUrl["protocol"][];
	/**
	 * Checked hosts pinned to the address the SSRF check resolved (empty
	 * when private hosts are allowed: then the server resolves them).
	 */
	pins: HostPin[];
	auth: GitAuthMounts;
	memoryMb: number;
}

const WORKSPACE = "/workspace";
const AUTH_DIR = "/run/git";
const KNOWN_DIR = "/run/known";

function assertAbsolute(dir: string): string {
	if (!dir.startsWith("/") || path.posix.normalize(dir) !== dir) {
		throw internalError(`Invalid path ${dir}`);
	}
	return dir;
}

const bracket = (address: string) =>
	address.includes(":") ? `[${address}]` : address;

/** `GIT_CONFIG_*` env: config without files (git >= 2.31). */
export function gitConfigEnv(
	options: Pick<CloneContainerOptions, "protocols" | "pins">,
): Record<string, string> {
	const entries: [string, string][] = [
		["protocol.allow", "never"],
		...[...new Set(options.protocols)].map((protocol): [string, string] => [
			`protocol.${protocol}.allow`,
			"always",
		]),
		["http.followRedirects", "false"],
		["credential.helper", ""],
		["core.hooksPath", "/dev/null"],
		["core.symlinks", "true"],
		["submodule.recurse", "false"],
		["fetch.recurseSubmodules", "false"],
		["advice.detachedHead", "false"],
		["init.defaultBranch", "main"],
		["safe.directory", WORKSPACE],
	];
	// One entry per checked host (multi-valued key): every HTTP connection
	// git makes goes to the address the SSRF check approved.
	for (const pin of options.pins) {
		entries.push([
			"http.curloptResolve",
			`${pin.host}:${pin.port}:${bracket(pin.address)}`,
		]);
	}
	const env: Record<string, string> = {
		GIT_CONFIG_COUNT: String(entries.length),
	};
	entries.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	return env;
}

/**
 * `ssh` options of the clone (deploy key, TOFU host keys, pinning). SSH is
 * only ever used for the repository's own host (an SSH submodule on
 * another host is refused), so one `HostName` pin is enough.
 */
function gitSshCommand(
	options: Pick<CloneContainerOptions, "url" | "pins">,
	withKey: boolean,
): string {
	const parts = [
		"ssh",
		...(withKey ? [`-i ${AUTH_DIR}/key`, "-o IdentitiesOnly=yes"] : []),
		"-o BatchMode=yes",
		"-o StrictHostKeyChecking=accept-new",
		`-o UserKnownHostsFile=${KNOWN_DIR}/known_hosts`,
		"-o ConnectTimeout=20",
	];
	const pin = options.pins.find((item) => item.host === options.url.host);
	if (options.url.protocol === "ssh" && pin) {
		parts.push(`-o HostName=${pin.address}`, `-o HostKeyAlias=${pin.host}`);
	}
	return parts.join(" ");
}

/** Sets GIT_ASKPASS to a script reading the mounted token files. */
const ASKPASS_SNIPPET = [
	`printf '%s\\n' '#!/bin/sh' 'case "$1" in Username*) cat ${AUTH_DIR}/username ;; *) cat ${AUTH_DIR}/token ;; esac' > /tmp/askpass`,
	"chmod 700 /tmp/askpass",
	"export GIT_ASKPASS=/tmp/askpass",
].join("; ");

/** `docker run` of the git image with `script` and positional `args`. */
export function gitContainerCommand(
	options: CloneContainerOptions,
	script: string,
	args: string[],
): string {
	const env: Record<string, string> = {
		HOME: "/tmp",
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		...gitConfigEnv(options),
	};
	// Without a key ssh still must not prompt or use another identity.
	env.GIT_SSH_COMMAND = gitSshCommand(
		options,
		options.auth.kind === "deploy_key",
	);
	const mounts = [
		`-v ${q(`${assertAbsolute(options.workspace)}:${WORKSPACE}`)}`,
		`-v ${q(`${assertAbsolute(options.auth.knownHostsDir)}:${KNOWN_DIR}`)}`,
	];
	if (options.auth.authDir && options.auth.kind !== "none") {
		mounts.push(
			`-v ${q(`${assertAbsolute(options.auth.authDir)}:${AUTH_DIR}:ro`)}`,
		);
	}
	const prelude = [
		"set -eu",
		options.auth.kind === "token" ? ASKPASS_SNIPPET : "",
		`cd ${WORKSPACE}`,
	]
		.filter(Boolean)
		.join("\n");
	return [
		"docker run --rm",
		"--network bridge",
		"--cap-drop ALL",
		"--security-opt no-new-privileges",
		"--pids-limit 512",
		`--memory ${Math.max(256, Math.floor(options.memoryMb))}m`,
		"--entrypoint sh",
		...Object.entries(env).map(([key, value]) => `-e ${q(`${key}=${value}`)}`),
		...mounts,
		q(options.image),
		"-c",
		q(`${prelude}\n${script}`),
		"sb",
		...args.map(q),
	].join(" ");
}

/**
 * Clone phase: `$1` url, `$2` branch, `$3` commit (or ""). Fetches only the
 * one commit (depth 1) and prints its sha, metadata and submodule URLs.
 */
export const CLONE_SCRIPT = [
	"git init -q .",
	'git remote add origin "$1"',
	'if [ -n "$3" ]; then git fetch -q --depth 1 --no-tags origin "$3"; else git fetch -q --depth 1 --no-tags origin "refs/heads/$2"; fi',
	"git checkout -q --detach FETCH_HEAD",
	"sha=$(git rev-parse HEAD)",
	'if [ -n "$3" ] && [ "$sha" != "$3" ]; then echo "fetched $sha instead of $3" >&2; exit 3; fi',
	`echo "${MARK} commit $sha"`,
	`git log -1 --format='${MARK} meta %an%x1f%cI%x1f%s'`,
	`if [ -f .gitmodules ] && [ ! -L .gitmodules ]; then git config -f .gitmodules --get-regexp '^submodule\\..*\\.url$' | while read -r key value; do echo "${MARK} submodule $value"; done; fi`,
].join("\n");

/** Exit codes of the finalize script. */
export const SUBDIR_ESCAPE_EXIT = 94;
export const SUBDIR_MISSING_EXIT = 95;
export const DOCKERFILE_SYMLINK_EXIT = 92;

/**
 * Finalize phase: `$1` "1" to update submodules (one level, depth 1),
 * `$2` subdir ("" = root, normalised: no `.`, `..`, empty or trailing
 * segments), `$3` Dockerfile path (relative, no `..`).
 *
 * Paths here are later read by Docker on the *host* (`-f`, the build
 * context, `.dockerignore`), where a symlink resolves against the host
 * filesystem, not the checkout. So: the build folder must be a real
 * folder inside the checkout; the Dockerfile path may not go through a
 * symlink at any component (refused, even when dangling here); symlinked
 * `.dockerignore` files are deleted. Then the top-level entries and the
 * probed regular files (base64, first 64 KiB) are printed.
 */
export function finalizeScript(workspace = WORKSPACE): string {
	return [
		'if [ "$1" = 1 ]; then git submodule update --init --depth 1 --no-recommend-shallow -q; fi',
		"find . -name .git -prune -exec rm -rf {} +",
		'dir="$2"; [ -n "$dir" ] || dir=.',
		`if [ ! -e "$dir" ]; then echo "build folder $2 not found" >&2; exit ${SUBDIR_MISSING_EXIT}; fi`,
		'real=$(realpath "$dir")',
		`case "$real/" in ${workspace}/*) ;; *) echo "build folder leaves the repository" >&2; exit ${SUBDIR_ESCAPE_EXIT};; esac`,
		`want=${workspace}; if [ -n "$2" ]; then want="${workspace}/$2"; fi`,
		`if [ "$real" != "$want" ] || [ ! -d "$real" ]; then echo "build folder must be a real folder" >&2; exit ${SUBDIR_ESCAPE_EXIT}; fi`,
		'cd "$real"',
		// Every component of the Dockerfile path, the file itself included.
		'p=""; old_ifs=$IFS; IFS=/',
		"for part in $3; do",
		'  if [ -n "$p" ]; then p="$p/$part"; else p="$part"; fi',
		`  if [ -L "$p" ]; then IFS=$old_ifs; echo "$p is a symlink" >&2; exit ${DOCKERFILE_SYMLINK_EXIT}; fi`,
		"done",
		"IFS=$old_ifs",
		'for f in .dockerignore "$3.dockerignore"; do if [ -L "$f" ]; then rm -f -- "$f"; fi; done',
		`ls -1Ap | head -n 300 | while IFS= read -r entry; do echo "${MARK} file $entry"; done`,
		'for f in "$3" package.json index.html; do',
		'  if [ -f "$f" ] && [ ! -L "$f" ]; then',
		'    r=$(realpath "$f")',
		`    case "$r" in "$real"/*) echo "${MARK} content $f $(head -c 65536 "$f" | base64 | tr -d '\\n')" ;; esac`,
		"  fi",
		"done",
	].join("\n");
}

export const FINALIZE_SCRIPT = finalizeScript();

export interface CloneOutput {
	commitSha: string;
	author: string;
	committedAt: string | null;
	message: string;
	submodules: string[];
}

/** Parse the clone phase's markers (the last of each kind wins). */
export function parseCloneOutput(output: string): CloneOutput {
	let commitSha = "";
	let meta: string[] = [];
	const submodules: string[] = [];
	for (const line of output.split("\n")) {
		if (!line.startsWith(`${MARK} `)) continue;
		const rest = line.slice(MARK.length + 1);
		const space = rest.indexOf(" ");
		const kind = space === -1 ? rest : rest.slice(0, space);
		const value = space === -1 ? "" : rest.slice(space + 1);
		if (kind === "commit" && /^[0-9a-f]{40}$/.test(value)) commitSha = value;
		else if (kind === "meta") meta = value.split("\x1f");
		else if (kind === "submodule" && value) submodules.push(value.trim());
	}
	if (!commitSha) throw new AppError("GIT_NO_COMMIT");
	const committedAt =
		meta[1] && !Number.isNaN(Date.parse(meta[1])) ? meta[1] : null;
	return {
		commitSha,
		author: clip(meta[0] ?? "", TEXT_LIMITS.shortText),
		committedAt,
		message: clip(meta.slice(2).join(" "), TEXT_LIMITS.message),
		submodules,
	};
}

export interface RepoProbe {
	/** Top-level entries of the build folder (directories end with `/`). */
	files: string[];
	/** Probed file contents (UTF-8), by name. */
	contents: Record<string, string>;
}

export function parseProbeOutput(output: string): RepoProbe {
	const files: string[] = [];
	const contents: Record<string, string> = {};
	for (const line of output.split("\n")) {
		if (line.startsWith(`${MARK} file `)) {
			files.push(line.slice(`${MARK} file `.length));
		} else if (line.startsWith(`${MARK} content `)) {
			const rest = line.slice(`${MARK} content `.length);
			const space = rest.lastIndexOf(" ");
			if (space <= 0) continue;
			contents[rest.slice(0, space)] = Buffer.from(
				rest.slice(space + 1),
				"base64",
			).toString("utf8");
		}
	}
	return { files, contents };
}

// ---------------------------------------------------------------------------
// BuildKit builder

export interface BuilderOptions {
	name: string;
	image: string;
}

const builderContainer = (name: string) => `buildx_buildkit_${name}0`;

/** Exit code of `ensureBuilderCommand` when buildx is not installed. */
export const BUILDX_MISSING_EXIT = 90;

/**
 * Make sure the dedicated buildx builder exists with the pinned BuildKit
 * image (recreated when the pin changed) and is running.
 */
export function ensureBuilderCommand(options: BuilderOptions): string {
	const name = q(options.name);
	const container = q(builderContainer(options.name));
	const image = q(options.image);
	return [
		`if ! docker buildx version >/dev/null 2>&1; then echo "docker buildx is not installed on this server (package docker-buildx-plugin)" >&2; exit ${BUILDX_MISSING_EXIT}; fi`,
		`current=$(docker inspect -f '{{.Config.Image}}' ${container} 2>/dev/null || true)`,
		`if [ -n "$current" ] && [ "$current" != ${image} ]; then docker buildx rm ${name} >/dev/null 2>&1 || true; fi`,
		`if ! docker buildx inspect ${name} >/dev/null 2>&1; then docker buildx create --name ${name} --driver docker-container --driver-opt ${q(`image=${options.image}`)} >/dev/null; fi`,
		`docker buildx inspect --bootstrap ${name} >/dev/null`,
	].join("\n");
}

/** Apply a build's memory/CPU limits to the builder container. */
export function builderLimitsCommand(
	options: BuilderOptions,
	limits: { memoryMb: number; cpus: number },
): string {
	const memory = `${Math.max(256, Math.floor(limits.memoryMb))}m`;
	const cpus = Math.max(0.1, limits.cpus).toFixed(2);
	return `docker update --memory ${memory} --memory-swap ${memory} --cpus ${cpus} ${q(builderContainer(options.name))} >/dev/null`;
}

/** Trim the builder's cache after a build. */
export function pruneBuildCacheCommand(
	options: BuilderOptions,
	keepMb: number,
): string {
	const name = q(options.name);
	const keep = `${Math.max(0, Math.floor(keepMb))}mb`;
	return `docker buildx prune --builder ${name} --force --max-used-space ${keep} >/dev/null 2>&1 || docker buildx prune --builder ${name} --force --keep-storage ${keep} >/dev/null 2>&1 || true`;
}

// ---------------------------------------------------------------------------
// Builds

export interface ImageBuild {
	builder: BuilderOptions;
	tag: string;
	/** Build context (host folder). */
	context: string;
	/** Dockerfile or plan file (host path). */
	file: string;
	target?: string | null;
	buildArgs: Record<string, string>;
	/** Secret id -> host file (0600). */
	secrets: Record<string, string>;
	labels: Record<string, string>;
}

const TAG = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const LABEL = /^[a-z0-9][a-z0-9._-]*$/;
const SECRET_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function assertImageTag(tag: string): string {
	if (!TAG.test(tag)) throw internalError(`Invalid image tag ${tag}`);
	return tag;
}

/** `docker buildx build` with plain progress, loaded into the local images. */
export function buildxCommand(build: ImageBuild): string {
	const args = [
		"docker buildx build",
		`--builder ${q(build.builder.name)}`,
		"--progress plain",
		"--load",
		"--provenance=false",
		`-t ${q(assertImageTag(build.tag))}`,
		`-f ${q(assertAbsolute(build.file))}`,
	];
	if (build.target) args.push(`--target ${q(build.target)}`);
	for (const [key, value] of Object.entries(build.labels)) {
		if (!LABEL.test(key)) throw internalError(`Invalid label ${key}`);
		args.push(`--label ${q(`${key}=${value}`)}`);
	}
	for (const [key, value] of Object.entries(build.buildArgs)) {
		if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
			throw new TemplateError("GIT_BUILD_ARG_INVALID", { name: key });
		}
		args.push(`--build-arg ${q(`${key}=${value}`)}`);
	}
	for (const [id, file] of Object.entries(build.secrets)) {
		if (!SECRET_ID.test(id)) {
			throw new TemplateError("GIT_SECRET_INVALID", { name: id });
		}
		args.push(`--secret ${q(`id=${id},src=${assertAbsolute(file)}`)}`);
	}
	args.push(q(assertAbsolute(build.context)));
	return args.join(" ");
}

/**
 * Re-tag `source` as `tag` with Nitrobase's labels (frontends such as
 * Railpack's may drop `--label`): a metadata-only build on the local
 * images, no layers added.
 */
export function relabelCommand(
	source: string,
	tag: string,
	labels: Record<string, string>,
): string {
	const labelArgs = Object.entries(labels).map(([key, value]) => {
		if (!LABEL.test(key)) throw internalError(`Invalid label ${key}`);
		return `--label ${q(`${key}=${value}`)}`;
	});
	return [
		`printf 'FROM %s\\n' ${q(assertImageTag(source))}`,
		"|",
		`DOCKER_BUILDKIT=1 docker build -q ${labelArgs.join(" ")} -t ${q(assertImageTag(tag))} -`,
		">/dev/null",
		`&& docker image rm ${q(source)} >/dev/null`,
	].join(" ");
}

/** The Railpack CLI tools image, built once per server (checksum-verified). */
export interface RailpackTools {
	image: string;
	baseImage: string;
	version: string;
	downloadUrl: string;
	sha256: { amd64: string; arm64: string };
}

export function railpackToolsImage(version: string): string {
	return `${resourceName("railpack")}:${version}`;
}

export function ensureRailpackToolsCommand(tools: RailpackTools): string {
	const base = `${tools.downloadUrl.replace(/\/$/, "")}/${tools.version}/railpack-${tools.version}`;
	const dockerfile = [
		`FROM ${tools.baseImage}`,
		"RUN apk add --no-cache curl ca-certificates",
		[
			"RUN set -eu;",
			'case "$(uname -m)" in',
			`x86_64) arch=x86_64; sum=${tools.sha256.amd64} ;;`,
			`aarch64|arm64) arch=arm64; sum=${tools.sha256.arm64} ;;`,
			'*) echo "unsupported architecture" >&2; exit 1 ;;',
			"esac;",
			`curl -fsSL -o /tmp/railpack.tgz "${base}-$arch-unknown-linux-musl.tar.gz";`,
			'echo "$sum  /tmp/railpack.tgz" | sha256sum -c -;',
			"tar -xzf /tmp/railpack.tgz -C /usr/local/bin railpack;",
			"rm /tmp/railpack.tgz;",
			"railpack --version",
		].join(" "),
	];
	return `docker image inspect ${q(tools.image)} >/dev/null 2>&1 || printf '%s\\n' ${dockerfile.map(q).join(" ")} | DOCKER_BUILDKIT=1 docker build -q -t ${q(tools.image)} - >/dev/null`;
}

/** Value given to `railpack prepare` for each build secret. */
export const RAILPACK_SECRET_PLACEHOLDER = `__${APP_ID}_secret__`;

/**
 * `railpack prepare` in the tools container: reads the build folder
 * (read-only), writes the plan to `planDir`. Build secrets are declared by
 * name with a placeholder value, so they become plan secrets without their
 * values ever being passed here; the real values reach the build only as
 * BuildKit `--secret` files.
 */
export function railpackPrepareCommand(options: {
	toolsImage: string;
	context: string;
	planDir: string;
	secretNames: string[];
}): string {
	const envArgs = options.secretNames.map((name) => {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
			throw new TemplateError("GIT_SECRET_INVALID", { name });
		}
		return `--env ${q(`${name}=${RAILPACK_SECRET_PLACEHOLDER}`)}`;
	});
	return [
		"docker run --rm",
		"--network bridge",
		"--cap-drop ALL",
		"--security-opt no-new-privileges",
		`-v ${q(`${assertAbsolute(options.context)}:/app:ro`)}`,
		`-v ${q(`${assertAbsolute(options.planDir)}:/out`)}`,
		"--entrypoint railpack",
		q(options.toolsImage),
		"prepare /app --plan-out /out/railpack-plan.json --info-out /out/railpack-info.json",
		...envArgs,
	].join(" ");
}

/**
 * A Railpack plan must hold secret names only, never a value: neither a
 * real one nor the placeholder given to `prepare` (a placeholder in an env
 * section means it was baked in as a plain variable instead of being
 * treated as a secret, so the app would run with it as its value).
 */
export function planHasSecretValue(plan: string, values: string[]): boolean {
	if (plan.includes(RAILPACK_SECRET_PLACEHOLDER)) return true;
	return values.some((value) => value.length >= 4 && plan.includes(value));
}

/** Dockerfile of a static site: optional build stage, then the server image. */
export function staticDockerfile(options: {
	buildImage: string;
	serveImage: string;
	buildCommand: string;
	outputDir: string;
	secretNames: string[];
}): string {
	const out = options.outputDir.replace(/^\.\/?/, "").replace(/\/+$/, "");
	const source = out ? `${out}/` : "./";
	if (!options.buildCommand.trim()) {
		return [
			`FROM ${options.serveImage}`,
			`COPY ${JSON.stringify([source, "/public/"])}`,
			"",
		].join("\n");
	}
	const mounts = options.secretNames
		.map((name) => {
			if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
				throw new TemplateError("GIT_SECRET_INVALID", { name });
			}
			return `--mount=type=secret,id=${name},env=${name}`;
		})
		.join(" ");
	return [
		`FROM ${options.buildImage} AS build`,
		"WORKDIR /src",
		"COPY . .",
		`RUN ${mounts ? `${mounts} ` : ""}${JSON.stringify(["sh", "-c", options.buildCommand])}`,
		`FROM ${options.serveImage}`,
		`COPY --from=build ${JSON.stringify([`/src/${source}`, "/public/"])}`,
		"",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Images

/**
 * The app label of an image (exit 1 when there is no such image): a tag is only reused when it was built for this app.
 */
export function imageAppLabelCommand(tag: string): string {
	return `docker image inspect -f '${labelValueTemplate("app")}' ${q(assertImageTag(tag))} 2>/dev/null`;
}

/**
 * Tags of the app's images (by the app label). Fails when the listing
 * fails: callers must not mistake a Docker error for "no images".
 */
export function appImagesCommand(appId: string): string {
	if (!/^[0-9a-f-]{36}$/.test(appId)) throw internalError("Invalid app id");
	return `docker image ls --filter ${q(labelFilter("app", appId))} --format '{{.Repository}}:{{.Tag}}'`;
}

/** Remove images without `-f`: one still used by a container is kept. */
export function removeAppImagesScript(tags: string[]): string | null {
	const valid = tags.filter((tag) => TAG.test(tag));
	if (valid.length === 0) return null;
	return valid
		.map(
			(tag) =>
				`if docker image rm -- ${q(tag)} >/dev/null 2>&1; then echo "removed ${tag}"; else echo "kept ${tag}"; fi`,
		)
		.join("\n");
}

/** Labels every app image carries. */
export function imageLabels(input: {
	appId: string;
	instanceId: string;
	commitSha: string;
}): Record<string, string> {
	return {
		[DOCKER_LABELS.app]: input.appId,
		[DOCKER_LABELS.instance]: input.instanceId,
		[DOCKER_LABELS.commit]: input.commitSha,
	};
}

// ---------------------------------------------------------------------------
// Leftover build folders

const RUN_DIR =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[0-9a-f]{8}\/build\/run-[0-9a-f]{8}$/;
const INSPECT_DIR = /^[0-9a-f-]{36}$/;

/**
 * A folder a git job may leave behind: `<apps>/<folder>/build/run-<job>`
 * or `<git-inspect>/<uuid>`. Anything else is never removed by the sweep.
 */
export function isGitWorkDir(
	dir: string,
	roots: { apps: string; gitInspect: string },
): boolean {
	if (dir.startsWith(`${roots.apps}/`)) {
		return RUN_DIR.test(dir.slice(roots.apps.length + 1));
	}
	if (dir.startsWith(`${roots.gitInspect}/`)) {
		return INSPECT_DIR.test(dir.slice(roots.gitInspect.length + 1));
	}
	return false;
}

/**
 * Remove build run folders and wizard checks older than any build could
 * run, plus `deadDirs` (folders of finished/interrupted jobs) whatever
 * their age. Prints every removed folder.
 */
export function gitSweepCommand(
	roots: { apps: string; gitInspect: string },
	minutes: number,
	deadDirs: string[] = [],
): string {
	const age = Math.max(1, Math.ceil(minutes));
	const dead = deadDirs
		.filter((dir) => isGitWorkDir(dir, roots))
		.map((dir) => `[ -d ${q(dir)} ] && echo ${q(dir)} && rm -rf -- ${q(dir)}`);
	return [
		`if [ -d ${q(roots.gitInspect)} ]; then find ${q(roots.gitInspect)} -mindepth 1 -maxdepth 1 -type d -mmin +${age} -print -exec rm -rf -- {} +; fi`,
		`if [ -d ${q(roots.apps)} ]; then find ${q(roots.apps)} -mindepth 3 -maxdepth 3 -type d -path '*/build/run-*' -mmin +${age} -print -exec rm -rf -- {} +; fi`,
		...dead,
		"true",
	].join("\n");
}

/**
 * Branch tip without a clone (update check): `$1` url, `$2` branch. Prints
 * `<sha>\trefs/heads/<branch>` (nothing when the branch does not exist).
 */
export const LS_REMOTE_SCRIPT = 'git ls-remote --heads -- "$1" "refs/heads/$2"';

/** The SHA of `refs/heads/<branch>` in `git ls-remote` output, or null. */
export function parseLsRemote(output: string, branch: string): string | null {
	for (const line of output.split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/);
		if (ref === `refs/heads/${branch}` && /^[0-9a-f]{40}$/.test(sha ?? "")) {
			return sha;
		}
	}
	return null;
}
