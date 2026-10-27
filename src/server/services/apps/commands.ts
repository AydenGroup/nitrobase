import path from "node:path";
import {
	DOCKER_LABELS,
	labelValueTemplate,
	listLabel,
} from "#/config/identifiers.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import {
	APP_OWNER_FILE,
	isInstanceId,
	readMarkerSnippet,
} from "#/server/services/ownership.ts";
import {
	APP_FOLDER_PATTERN,
	assertSlug,
	TemplateError,
} from "#/server/services/templates/naming.ts";
import { internalError } from "#/utils/error.ts";
import { attachNetworksScript } from "./networks";
import { OOM_NOW_PREFIX } from "./oom.ts";

/**
 * Shell command builders for app lifecycle jobs. Every dynamic value is
 * validated and shell-quoted here; jobs only pass these strings to an
 * Executor. Pure, so the exact commands are unit-tested.
 */

export interface AppLocation {
	/** Compose project / folder name (slug). */
	folder: string;
	/** Absolute app directory, `<apps root>/<folder>`. */
	appRoot: string;
	/**
	 * The app's id (`nitrobase.app` label): only containers carrying it are
	 * attached to shared networks. Without it nothing is attached.
	 */
	appId?: string;
}

const SERVICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function assertAppLocation(
	location: AppLocation,
	appsRoot: string,
): AppLocation {
	assertSlug(location.folder);
	if (location.appRoot !== path.posix.join(appsRoot, location.folder)) {
		throw internalError("App folder must be directly under the apps root");
	}
	return location;
}

export function assertServiceName(service: string): string {
	if (!SERVICE_PATTERN.test(service)) {
		throw new TemplateError("SERVICE_NAME_INVALID", { service });
	}
	return service;
}

/** `docker compose` scoped to the app's project, files and env. */
function composeCommand(location: AppLocation, args: string[]): string {
	return [
		`cd ${q(location.appRoot)} &&`,
		"docker compose",
		`-p ${q(location.folder)}`,
		"--project-directory .",
		"-f docker-compose.yml",
		"--env-file .env",
		...args,
	].join(" ");
}

/** Project-only compose (no files): works after a partial deploy too. */
export function composeProjectCommand(folder: string, args: string[]): string {
	return ["docker compose", `-p ${q(assertSlug(folder))}`, ...args].join(" ");
}

export function composeConfigCommand(location: AppLocation): string {
	return composeCommand(location, ["config", "--format", "json"]);
}

/** Pull images and build, retrying transient registry/network failures. */
export function composePrepareCommand(
	location: AppLocation,
	retries: number,
): string {
	const attempts = Math.max(1, Math.floor(retries));
	const run = `${composeCommand(location, ["pull", "--ignore-buildable", "--quiet"])} && ${composeCommand(location, ["build", "--pull"])}`;
	return [
		`for attempt in $(seq 1 ${attempts}); do`,
		`  if ${run}; then exit 0; fi`,
		`  if [ "$attempt" -lt ${attempts} ]; then echo "Pull/build failed (attempt $attempt/${attempts}), retrying in 10s..." >&2; sleep 10; fi`,
		"done",
		"exit 1",
	].join("\n");
}

/** `up` flags that do not apply to `up --no-start`. */
const START_ONLY_FLAGS = new Set(["-d", "--detach", "--wait"]);

/**
 * Every compose command that creates or starts containers goes through
 * here, so the app's containers are on their shared networks (proxy,
 * database links) whatever the path: those networks are joined with
 * `docker network connect`, never through the compose file (see
 * `apps/networks.ts`).
 * - `up`: `up --no-start` (create/recreate), attach, then `up` (starts
 *   them, attached from the first second; `--force-recreate` only in the
 *   first phase or the second would recreate them again, detached);
 * - `start`/`restart`: attach first (stopped containers keep it);
 * - `create`: attach after.
 * `args` are already quoted.
 */
export function composeLifecycleCommand(
	location: AppLocation,
	args: string[],
): string {
	// Callers may quote every word (`'up'`).
	const bare = (arg: string) =>
		/^'[^']*'$/.test(arg) ? arg.slice(1, -1) : arg;
	const [action = "", ...rest] = args;
	const attach = attachNetworksScript(location);
	switch (bare(action)) {
		case "up":
			return [
				composeCommand(location, [
					"up",
					"--no-start",
					...rest.filter((arg) => !START_ONLY_FLAGS.has(bare(arg))),
				]),
				attach,
				composeCommand(location, [
					"up",
					...rest.filter((arg) => bare(arg) !== "--force-recreate"),
				]),
			].join(" &&\n");
		case "start":
		case "restart":
			return `${attach} &&\n${composeCommand(location, args)}`;
		case "create":
			return `${composeCommand(location, args)} &&\n${attach}`;
		default:
			return composeCommand(location, args);
	}
}

export function composeUpCommand(location: AppLocation): string {
	return composeLifecycleCommand(location, [
		"up",
		"-d",
		"--remove-orphans",
		"--no-build",
	]);
}

export type ServiceAction = "start" | "stop" | "restart";

export function composeServiceCommand(
	location: AppLocation,
	action: ServiceAction,
	service?: string,
): string {
	const args: string[] = [action];
	if (service) args.push(q(assertServiceName(service)));
	return composeLifecycleCommand(location, args);
}

/**
 * Start exactly `services` (stopped by a job) in one command: compose
 * starts them in `depends_on` order and leaves every other service as it is
 * (a bare `start` would also start services the owner stopped and re-run
 * finished one-shot containers).
 */
export function composeStartServicesCommand(
	location: AppLocation,
	services: readonly string[],
): string {
	return composeLifecycleCommand(location, [
		"start",
		...services.map((service) => q(assertServiceName(service))),
	]);
}

/** Recreate one service so it picks up changed env files (no dependents). */
export function composeRecreateServiceCommand(
	location: AppLocation,
	service: string,
): string {
	return composeLifecycleCommand(location, [
		"up",
		"-d",
		"--no-deps",
		"--no-build",
		"--force-recreate",
		q(assertServiceName(service)),
	]);
}

export function composeDownCommand(
	location: AppLocation,
	removeVolumes: boolean,
): string {
	return composeProjectCommand(location.folder, [
		"down",
		"--remove-orphans",
		...(removeVolumes ? ["--volumes"] : []),
	]);
}

export function composeLogsCommand(
	location: AppLocation,
	options: {
		service?: string;
		tail: number;
		follow: boolean;
		/** Docker timestamps (default on; apps often print their own). */
		timestamps?: boolean;
	},
): string {
	const tail = Math.max(0, Math.floor(options.tail));
	const args = ["logs", "--no-color"];
	if (options.timestamps !== false) args.push("--timestamps");
	// One service: the `<container> |` prefix is noise.
	if (options.service) args.push("--no-log-prefix");
	args.push(`--tail ${tail}`);
	if (options.follow) args.push("--follow");
	if (options.service) args.push(q(assertServiceName(options.service)));
	return composeCommand(location, args);
}

/**
 * `docker inspect` fields of the readiness poll, tab separated (see
 * `parseServiceStatus`): compose service, state, exit code, restart count,
 * health (empty without a healthcheck). Labels and state only.
 */
const STATUS_INSPECT_FORMAT = [
	'{{index .Config.Labels "com.docker.compose.service"}}',
	"{{.State.Status}}",
	"{{.State.ExitCode}}",
	"{{.RestartCount}}",
	"{{if .State.Health}}{{.State.Health.Status}}{{end}}",
].join("\t");

/**
 * One line per container of the project, for readiness polling. `compose
 * ps` must succeed; a container removed between `ps` and `inspect` is
 * left out (inspect's error is ignored).
 */
export function composeStatusCommand(location: AppLocation): string {
	return inspectProjectCommand(location, STATUS_INSPECT_FORMAT);
}

/** `docker inspect --format` of every container of the project. */
function inspectProjectCommand(location: AppLocation, format: string): string {
	return inspectIdsCommand(
		composeCommand(location, ["ps", "--all", "-q"]),
		format,
	);
}

function inspectIdsCommand(listIds: string, format: string): string {
	return [
		`ids=$(${listIds}) || exit $?`,
		'[ -n "$ids" ] || exit 0',
		`docker inspect --format ${q(format)} $ids 2>/dev/null`,
		"exit 0",
	].join("\n");
}

/**
 * `composeStatusCommand` for every container labelled with the compose
 * project, whatever compose file made it (a failed update's services the
 * deployed compose does not name are included): what a backup must stop.
 */
export function projectStatusCommand(folder: string): string {
	return inspectIdsCommand(
		`docker ps --all -q --filter ${q(`label=com.docker.compose.project=${assertSlug(folder)}`)}`,
		STATUS_INSPECT_FORMAT,
	);
}

/**
 * Per container of the project: compose service, container id,
 * `State.StartedAt`, `State.Status`, tab separated (see
 * `parseContainerIdentities` in `dependents.ts`). Taken around `up`, it
 * tells which services `up` recreated or (re)started. Labels and state
 * only.
 */
export function composeIdentityCommand(location: AppLocation): string {
	return inspectProjectCommand(
		location,
		[
			'{{index .Config.Labels "com.docker.compose.service"}}',
			"{{.Id}}",
			"{{.State.StartedAt}}",
			"{{.State.Status}}",
		].join("\t"),
	);
}

/**
 * Restart exactly `services` (compose orders them by `depends_on`): the
 * running dependents of a service `up` recreated (see `dependents.ts`).
 */
export function composeRestartServicesCommand(
	location: AppLocation,
	services: readonly string[],
): string {
	return composeLifecycleCommand(location, [
		"restart",
		...services.map((service) => q(assertServiceName(service))),
	]);
}

/**
 * The host's clock (`now<TAB>epoch seconds`), then per container of the
 * app: compose service, `State.OOMKilled`, memory limit in bytes (0: none),
 * `State.FinishedAt`, tab separated (see `parseOomKills`). Labels and state
 * only: never env or config with secrets.
 */
const OOM_FORMAT = [
	`{{index .Config.Labels "com.docker.compose.service"}}`,
	"{{.State.OOMKilled}}",
	"{{.HostConfig.Memory}}",
	"{{.State.FinishedAt}}",
].join("\t");

export function composeOomCommand(location: AppLocation): string {
	return [
		`printf '${OOM_NOW_PREFIX}\\t%s\\n' "$(date +%s)";`,
		`ids=$(${composeCommand(location, ["ps", "-aq"])});`,
		`[ -n "$ids" ] && docker inspect --format ${q(OOM_FORMAT)} $ids || true`,
	].join(" ");
}

/**
 * HTTP probe from a throwaway container on the proxy network. Prints the
 * status code; any response below 500 counts as up.
 */
export function httpProbeCommand(options: {
	network: string;
	image: string;
	container: string;
	port: number;
	path: string;
}): string {
	if (!/^\/[A-Za-z0-9._~\-/?=&]*$/.test(options.path)) {
		throw new TemplateError("HEALTH_PATH_INVALID", { path: options.path });
	}
	const url = `http://${assertSlugLike(options.container)}:${Math.floor(options.port)}${options.path}`;
	return [
		"docker run --rm",
		`--network ${q(options.network)}`,
		q(options.image),
		"-s -o /dev/null -w '%{http_code}' --max-time 5",
		q(url),
	].join(" ");
}

/** Template `[health] expect` statuses, or any response below 500. */
export function isHealthyStatus(code: number, expect?: number[]): boolean {
	if (!Number.isInteger(code) || code <= 0) return false;
	return expect ? expect.includes(code) : code < 500;
}

function assertSlugLike(value: string): string {
	if (!/^[a-z0-9][a-z0-9_.-]*$/.test(value)) {
		throw internalError(`Invalid container name "${value}"`);
	}
	return value;
}

/** Interactive shell in a service container (bash when available). */
export function containerShellCommand(
	container: string,
	tty: boolean,
	/** Verify the container carries this app's label first. */
	appId?: string,
): string {
	const check = appId
		? `${appContainerCheckScript([container], appId).replaceAll("\n", "; ")}; `
		: "";
	return (
		check +
		[
			"docker exec",
			tty ? "-it" : "-i",
			q(assertSlugLike(container)),
			"sh -c",
			q("command -v bash >/dev/null 2>&1 && exec bash || exec sh"),
		].join(" ")
	);
}

/** Images of the project's containers (one per line). */
export function projectImagesCommand(folder: string): string {
	return `docker ps -a --filter ${q(`label=com.docker.compose.project=${assertSlug(folder)}`)} --format '{{.Image}}' | sort -u`;
}

const IMAGE_REF = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/;

export function parseImageList(output: string): string[] {
	return [
		...new Set(
			output
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => IMAGE_REF.test(line)),
		),
	].sort();
}

/**
 * Remove images after `down`. Without `-f`, Docker refuses to remove an
 * image any other container (running or stopped) still uses, so shared
 * images are kept.
 */
export function removeImagesScript(images: string[]): string | null {
	const valid = images.filter((image) => IMAGE_REF.test(image));
	if (valid.length === 0) return null;
	return valid
		.map(
			(image) =>
				`docker image rm -- ${q(image)} >/dev/null 2>&1 && echo "Removed image ${image}" || echo "Kept image ${image} (still in use)"`,
		)
		.join("\n");
}

/** Remove the app folder (and only that folder). */
export function removeAppFolderCommand(location: AppLocation): string {
	return `rm -rf -- ${q(location.appRoot)}`;
}

export function removeFileCommand(target: string): string {
	return `rm -f -- ${q(target)}`;
}

/** chmod +x for template files that are executable in git. */
export function chmodExecutableCommand(
	location: AppLocation,
	files: string[],
): string | null {
	if (files.length === 0) return null;
	const targets = files.map((file) =>
		q(path.posix.join(location.appRoot, file)),
	);
	return `chmod 0755 -- ${targets.join(" ")}`;
}

export interface ServiceStatus {
	service: string;
	state: string;
	health: string;
	/** Last exit code (meaningful when `state` is `exited`). */
	exitCode: number | null;
	/** Docker's restart count of the container (reset when recreated). */
	restarts: number | null;
}

const intOrNull = (value: string | undefined): number | null =>
	value && /^-?\d+$/.test(value) ? Number.parseInt(value, 10) : null;

/** Lines of `composeStatusCommand` (`STATUS_INSPECT_FORMAT`). */
export function parseServiceStatus(output: string): ServiceStatus[] {
	const out: ServiceStatus[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const [service = "", state = "", exitCode, restarts, health = ""] = line
			.split("\t")
			.map((part) => part.trim());
		if (!service || service === "<no value>" || !state) continue;
		out.push({
			service,
			state,
			health: health === "<no value>" ? "" : health,
			exitCode: intOrNull(exitCode),
			restarts: intOrNull(restarts),
		});
	}
	return out;
}

/**
 * Exit code when a bind source resolves outside its path (symlink).
 * Known gap (TOCTOU): on redeploy the old containers keep running between
 * this check and `up`, so a container owning a writable bind dir could swap
 * in a symlink in that window. The deploy re-runs the check right after
 * `up` and stops the app on a mismatch (treated as a compromise).
 */
const BIND_ESCAPE_EXIT = 98;

/**
 * Exit code when a bind source expected to be a file is not one: a
 * required file (rendered by the deploy) that is missing or not a regular
 * file, or, after `up`, a file-named source that is an empty directory
 * (what Docker creates for a missing bind source). Its stderr holds
 * `BIND_FILE_MISSING_MARKER<path>`.
 */
export const BIND_FILE_MISSING_EXIT = 97;
const BIND_FILE_MISSING_MARKER = "bind-file-missing=";
/** Printed (stdout) before `up` for a file-named source that isn't a file yet. */
const BIND_FILE_WARNING_MARKER = "bind-file-warning=";

export interface BindFileExpectations {
	/** Absolute sources that must be regular files (rendered files). */
	files?: string[];
	/**
	 * Absolute sources named like files that nothing writes: never created
	 * as directories; before `up` reported (warning) when missing or an
	 * empty directory, after `up` refused when an empty directory.
	 */
	namedFiles?: string[];
	/** The check runs after `up` (named files are then enforced). */
	after?: boolean;
}

/**
 * Before `up`: every bind source inside the app folder must be a real path
 * (no symlinked component, e.g. one planted by a container in its writable
 * volume), and missing ones are created as directories without following
 * links, except sources expected to be files (`expect`), which are never
 * created (Docker would mount an empty directory). Sources outside the app
 * folder were allowlisted by the template.
 */
export function bindSourcesCheckScript(
	location: AppLocation,
	sources: string[],
	expect: BindFileExpectations = {},
): string {
	const lines = ["set -e"];
	const normalize = (list: string[] = []) =>
		new Set(list.map((file) => path.posix.normalize(file)));
	const required = normalize(expect.files);
	const named = normalize(expect.namedFiles);
	for (const source of [...new Set(sources)].sort()) {
		const normalized = path.posix.normalize(source);
		if (
			normalized !== location.appRoot &&
			!normalized.startsWith(`${location.appRoot}/`)
		) {
			continue;
		}
		const src = q(normalized);
		const missing = `{ echo ${q(BIND_FILE_MISSING_MARKER)}${src} >&2; exit ${BIND_FILE_MISSING_EXIT}; }`;
		const emptyDir = `[ -d ${src} ] && [ -z "$(ls -A -- ${src})" ]`;
		lines.push(
			`[ "$(realpath -m -- ${src})" = ${src} ] || { echo "Bind source is a symlink: "${src} >&2; exit ${BIND_ESCAPE_EXIT}; }`,
		);
		if (required.has(normalized)) {
			lines.push(`[ -f ${src} ] || ${missing}`);
		} else if (named.has(normalized)) {
			lines.push(
				expect.after
					? `if ${emptyDir}; then ${missing}; fi`
					: `if [ ! -e ${src} ] || { ${emptyDir}; }; then echo ${q(BIND_FILE_WARNING_MARKER)}${src}; fi`,
			);
		} else {
			lines.push(`[ -e ${src} ] || mkdir -p -- ${src}`);
		}
		// A named file may still be missing before `up` (Docker creates it).
		const exists = named.has(normalized) ? `[ ! -e ${src} ] || ` : "";
		lines.push(
			`${exists}[ "$(realpath -e -- ${src})" = ${src} ] || { echo "Bind source is a symlink: "${src} >&2; exit ${BIND_ESCAPE_EXIT}; }`,
		);
	}
	return lines.join("\n");
}

/** The path a failed `bindSourcesCheckScript` reports as not a file. */
export function parseBindFileMissing(stderr: string): string | null {
	const line = stderr
		.split("\n")
		.find((item) => item.startsWith(BIND_FILE_MISSING_MARKER));
	return line ? line.slice(BIND_FILE_MISSING_MARKER.length).trim() : null;
}

/** Paths a passing `bindSourcesCheckScript` reports as not files yet. */
export function parseBindFileWarnings(stdout: string): string[] {
	return stdout
		.split("\n")
		.filter((item) => item.startsWith(BIND_FILE_WARNING_MARKER))
		.map((item) => item.slice(BIND_FILE_WARNING_MARKER.length).trim());
}

/**
 * Before files are written: an empty directory where a rendered file goes
 * (left by Docker when an earlier deploy bind-mounted the file before it
 * was written) is removed so the file can take its place. Never follows a
 * symlink; a non-empty directory is left (the upload then fails). Prints
 * `replaced=<path>` per removed directory.
 */
export function emptyDirsAtFilesScript(
	location: AppLocation,
	files: string[],
): string {
	const lines: string[] = [];
	for (const file of [...new Set(files)].sort()) {
		const target = path.posix.join(location.appRoot, file);
		if (!target.startsWith(`${location.appRoot}/`)) continue;
		const p = q(target);
		lines.push(
			`if [ -d ${p} ] && [ ! -L ${p} ] && [ "$(realpath -m -- ${p})" = ${p} ] && rmdir -- ${p} 2>/dev/null; then echo replaced=${p}; fi`,
		);
	}
	lines.push("true");
	return lines.join("\n");
}

/** Absolute bind sources from `docker compose config --format json`. */
export function resolvedBindSources(model: unknown): string[] {
	const sources: string[] = [];
	const services = (
		model as { services?: Record<string, { volumes?: unknown[] }> }
	)?.services;
	for (const service of Object.values(services ?? {})) {
		for (const volume of service.volumes ?? []) {
			const entry = volume as { type?: string; source?: string };
			if (entry?.type === "bind" && typeof entry.source === "string") {
				sources.push(entry.source);
			}
		}
	}
	return sources;
}

/**
 * What an app without stored env finds on its server (an interrupted first
 * deploy may have written its `.env` and initialised data with it):
 * - `owner=`: the folder's owner marker (`-`: none);
 * - `env=`: the `.env` as one base64 line, only when the folder is this
 *   instance's (`-`: not read). Secret: run quietly, never log the output;
 * - `volumes=`: named volumes of the compose project.
 * Never fails on a missing folder or Docker error (prints `-`/0).
 */
export function appEnvProbeScript(
	location: AppLocation,
	instanceId: string,
): string {
	if (!isInstanceId(instanceId)) throw internalError("Invalid instance id");
	const dir = q(location.appRoot);
	const marker = q(`${location.appRoot}/${APP_OWNER_FILE}`);
	const env = q(`${location.appRoot}/.env`);
	return [
		`o=$(${readMarkerSnippet(marker)})`,
		'echo "owner=$o"',
		`if [ "$o" = ${q(instanceId)} ] && [ -d ${dir} ] && [ ! -L ${dir} ] && [ -f ${env} ] && [ ! -L ${env} ]; then echo "env=$(base64 < ${env} | tr -d '\\n')"; else echo "env=-"; fi`,
		`echo "volumes=$(docker volume ls -q --filter ${q(`label=com.docker.compose.project=${location.folder}`)} 2>/dev/null | wc -l | tr -d ' ')"`,
		"true",
	].join("\n");
}

export interface AppEnvProbe {
	/** Owner marker of the folder (null: none). */
	owner: string | null;
	/** The folder's `.env` text (null: absent or not read). Secret. */
	envText: string | null;
	/** Named volumes of the compose project. */
	volumes: number;
}

export function parseAppEnvProbe(output: string): AppEnvProbe {
	const fields = new Map<string, string>();
	for (const line of output.split("\n")) {
		const index = line.indexOf("=");
		if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1));
	}
	const owner = fields.get("owner")?.trim();
	const env = fields.get("env")?.trim();
	const volumes = Number.parseInt(fields.get("volumes") ?? "", 10);
	return {
		owner: owner && owner !== "-" ? owner : null,
		envText:
			env && env !== "-" ? Buffer.from(env, "base64").toString("utf8") : null,
		volumes: Number.isFinite(volumes) && volumes > 0 ? volumes : 0,
	};
}

/**
 * Bind-mounted directories inside the app folder that hold data the app
 * writes (e.g. a database's data folder), from the rendered compose model:
 * sources under the app folder that are neither a rendered file nor a
 * directory containing rendered files (config the deploy writes itself).
 */
export function appDataBindDirs(
	location: AppLocation,
	composeModel: Record<string, unknown>,
	renderedPaths: string[],
): string[] {
	const root = location.appRoot;
	const rendered = renderedPaths.map((file) => path.posix.join(root, file));
	const dirs = new Set<string>();
	const services = (composeModel.services ?? {}) as Record<
		string,
		{ volumes?: unknown[] }
	>;
	for (const service of Object.values(services)) {
		for (const volume of service?.volumes ?? []) {
			let source: string | undefined;
			if (typeof volume === "string") {
				const parts = volume.split(":");
				if (parts.length > 1 && /^[./]/.test(parts[0])) source = parts[0];
			} else if (
				(volume as { type?: string })?.type === "bind" &&
				typeof (volume as { source?: unknown }).source === "string"
			) {
				source = (volume as { source: string }).source;
			}
			if (!source || source.includes("$")) continue;
			const dir = path.posix.resolve(root, source).replace(/\/+$/, "");
			if (!dir.startsWith(`${root}/`)) continue;
			if (rendered.some((file) => file === dir || file.startsWith(`${dir}/`))) {
				continue;
			}
			dirs.add(dir);
		}
	}
	return [...dirs].sort();
}

/** Prints `data=<n>`: how many of `dirs` are non-empty real directories. */
export function appDataDirsScript(dirs: string[]): string {
	const lines = ["n=0"];
	for (const dir of dirs) {
		const d = q(dir);
		lines.push(
			`if [ -d ${d} ] && [ ! -L ${d} ] && [ -n "$(ls -A -- ${d} 2>/dev/null)" ]; then n=$((n+1)); fi`,
		);
	}
	lines.push('echo "data=$n"');
	return lines.join("\n");
}

/**
 * Lists app folders (with their owner marker) and compose projects
 * (containers with state and owner label, volumes) on a host.
 */
export function orphanScanScript(appsRoot: string): string {
	const appLabel = listLabel(DOCKER_LABELS.app);
	return [
		`for d in ${q(appsRoot)}/*/; do [ -d "$d" ] || continue; echo "folder $(basename "$d") $(${readMarkerSnippet(`"$d${APP_OWNER_FILE}"`)})"; done`,
		// Only resources Nitrobase created (labelled by the compose transform):
		// the template prints a line only for labelled ones (`if` keeps the dot).
		`docker ps -a --format '{{if ${appLabel}}}{{printf "project %s %s %s" (.Label "com.docker.compose.project") .State (or (${listLabel(DOCKER_LABELS.instance)}) "-")}}{{end}}' 2>/dev/null`,
		`docker volume ls --format '{{if ${appLabel}}}volume {{.Label "com.docker.compose.project"}} {{.Name}}{{end}}' 2>/dev/null`,
		"true",
	].join("\n");
}

/**
 * - `self`: created by this instance (folder marker / container labels);
 * - `foreign`: another instance's id is recorded;
 * - `unknown`: no owner recorded (older installs, or a foreign panel).
 * Only `self` entries without running containers can be wiped.
 */
type OrphanOwner = "self" | "foreign" | "unknown";

export interface OrphanEntry {
	folder: string;
	hasFolder: boolean;
	containers: number;
	/** Containers currently running (a wipe is refused while any run). */
	running: number;
	volumes: string[];
	owner: OrphanOwner;
	/** May be wiped from the UI. */
	wipeable: boolean;
}

/** Group scan output by app folder/project, excluding known apps. */
export function parseOrphanScan(
	output: string,
	knownFolders: Set<string>,
	instanceId: string | null,
): OrphanEntry[] {
	const entries = new Map<
		string,
		Omit<OrphanEntry, "owner" | "wipeable"> & { owners: Set<string> }
	>();
	const get = (folder: string) => {
		let entry = entries.get(folder);
		if (!entry) {
			entry = {
				folder,
				hasFolder: false,
				containers: 0,
				running: 0,
				volumes: [],
				owners: new Set(),
			};
			entries.set(folder, entry);
		}
		return entry;
	};
	const owner = (value: string | undefined) =>
		value && value !== "-" && isInstanceId(value) ? value : null;
	for (const line of output.split("\n")) {
		const [kind, project, third, fourth] = line.trim().split(/\s+/);
		if (
			!project ||
			!APP_FOLDER_PATTERN.test(project) ||
			knownFolders.has(project)
		)
			continue;
		if (kind === "folder") {
			const entry = get(project);
			entry.hasFolder = true;
			const id = owner(third);
			if (id) entry.owners.add(id);
		} else if (kind === "project") {
			const entry = get(project);
			entry.containers++;
			if (third === "running" || third === "restarting" || third === "paused")
				entry.running++;
			const id = owner(fourth);
			if (id) entry.owners.add(id);
		} else if (kind === "volume" && third) get(project).volumes.push(third);
	}
	return [...entries.values()]
		.map(({ owners, ...entry }) => {
			const ownerKind: OrphanOwner =
				owners.size === 0
					? "unknown"
					: instanceId && owners.size === 1 && owners.has(instanceId)
						? "self"
						: "foreign";
			return {
				...entry,
				owner: ownerKind,
				wipeable: ownerKind === "self" && entry.running === 0,
			};
		})
		.sort((a, b) => a.folder.localeCompare(b.folder));
}

/** Create a bridge network if it is missing (idempotent). */
export function ensureNetworkCommand(network: string): string {
	return `docker network inspect ${q(network)} >/dev/null 2>&1 || docker network create --driver bridge ${q(network)} >/dev/null`;
}

/** Network attach used by the panel route (idempotent). */
export function connectNetworkCommand(
	network: string,
	container: string,
): string {
	return `docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' ${q(network)} | grep -qw ${q(container)} || docker network connect ${q(network)} ${q(container)}`;
}

/** Exit code of `appContainerCheckScript` when a container is not the app's. */
const NOT_APP_CONTAINER_EXIT = 96;

/**
 * Before any `docker exec` into an app container (terminal, tasks,
 * backups): the container must carry this app's `nitrobase.app` label, so a
 * same-named container of another project/panel is never entered.
 * Missing containers pass (the exec itself then fails clearly).
 */
export function appContainerCheckScript(
	containers: string[],
	appId: string,
): string {
	return containers
		.map((container) => {
			const name = q(assertSlugLike(container));
			return `if l=$(docker inspect -f '${labelValueTemplate("app")}' ${name} 2>/dev/null); then [ "$l" = ${q(appId)} ] || { echo "Container ${container} does not belong to this app" >&2; exit ${NOT_APP_CONTAINER_EXIT}; }; fi`;
		})
		.concat("true")
		.join("\n");
}
