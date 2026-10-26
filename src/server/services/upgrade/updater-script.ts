import { DOCKER_LABELS, labelValueTemplate } from "#/config/identifiers.ts";
import { APP_NAME, VERSION_ENV_NAME } from "#/config/shared.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { internalError } from "#/utils/error.ts";
import { type PanelInstall, versionLineEre } from "./install";
import { IMAGE_TAG } from "./releases";
import { UPDATER_EXIT, UPGRADE_MARKER } from "./state-machine";

/**
 * The updater (pure command builders). A short-lived container with the
 * Docker CLI and compose plugin, started by the panel through the host's
 * Docker socket, does what the panel cannot do from inside itself:
 *
 *   1. set the version variable in the install's `.env` (a copy of the old
 *      file is kept as `.env.before-upgrade`),
 *   2. `docker compose up -d --no-deps --pull never <service>`: the panel
 *      container is recreated on the new image (already pulled by the
 *      panel; its entrypoint runs the database migrations),
 *   3. wait until the new container is healthy and runs the new image,
 *   4. otherwise put the old version back in `.env` and recreate again
 *      (the image is still local), then wait for it to be healthy.
 *
 * Every value reaches the script as an environment variable (never
 * interpolated into it); the compose files go through COMPOSE_FILE.
 */
export interface UpdaterInput {
	install: PanelInstall;
	/** Image tag to switch to / back to. */
	targetVersion: string;
	previousVersion: string;
	healthTimeoutSeconds: number;
	healthPollSeconds: number;
	logTailLines: number;
	updaterImage: string;
	updaterContainer: string;
	dockerSocket: string;
	/** Job id (container label: which upgrade this updater belongs to). */
	deploymentId: string;
	instanceId: string;
}

/** Exit for a refused run: nothing was changed. */
const REFUSE = `exit ${UPDATER_EXIT.refused}`;

export const UPDATER_SCRIPT = [
	"set -u",
	`phase() { printf '${UPGRADE_MARKER} %s\\n' "$1"; }`,
	"say() { printf '%s\\n' \"$*\"; }",
	'compose() { docker compose --project-directory "$SB_DIR" --project-name "$SB_PROJECT" "$@"; }',
	// Rewrite the version variable of the `.env` (append it when missing).
	"set_version() {",
	'  tmp="$SB_DIR/.env.upgrade-tmp"',
	'  cp -p "$SB_DIR/.env" "$tmp" || return 1',
	`  if grep -Eq "${versionLineEre(VERSION_ENV_NAME)}" "$tmp"; then`,
	`    sed -E "s/${versionLineEre(VERSION_ENV_NAME)}.*/${VERSION_ENV_NAME}=$1/" "$tmp" > "$tmp.next" && mv -f "$tmp.next" "$tmp" || return 1`,
	`  else printf "${VERSION_ENV_NAME}=%s\\n" "$1" >> "$tmp" || return 1; fi`,
	'  chmod 600 "$tmp" && mv -f "$tmp" "$SB_DIR/.env"',
	"}",
	"wait_healthy() {",
	'  want="$SB_IMAGE_REPO:$1"',
	"  deadline=$(( $(date +%s) + SB_HEALTH_TIMEOUT ))",
	'  last=""',
	'  while [ "$(date +%s)" -lt "$deadline" ]; do',
	'    image=$(docker inspect -f "{{.Config.Image}}" "$SB_CONTAINER" 2>/dev/null || true)',
	'    state=$(docker inspect -f "{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" "$SB_CONTAINER" 2>/dev/null || true)',
	'    if [ "$state" != "$last" ]; then say "panel container: $state $image"; last="$state"; fi',
	'    if [ "$image" = "$want" ] && [ "$state" = "running/healthy" ]; then return 0; fi',
	'    sleep "$SB_POLL_SECONDS"',
	"  done",
	"  return 1",
	"}",
	"show_logs() {",
	'  say "Last lines of the panel container:"',
	'  docker logs --tail "$SB_LOG_LINES" "$SB_CONTAINER" 2>&1 | sed "s/^/  | /"',
	"}",
	"rollback() {",
	"  phase rolling_back",
	'  say "Putting $SB_APP_NAME $SB_PREVIOUS back..."',
	'  if ! set_version "$SB_PREVIOUS"; then say "ERROR: could not write .env (the previous one is .env.before-upgrade)"; phase failed; exit ' +
		String(UPDATER_EXIT.rollbackFailed) +
		"; fi",
	'  if compose up -d --no-deps --pull never "$SB_SERVICE" && wait_healthy "$SB_PREVIOUS"; then',
	'    say "$SB_APP_NAME $SB_PREVIOUS is running again."',
	"    phase rolled_back",
	`    exit ${UPDATER_EXIT.rolledBack}`,
	"  fi",
	"  show_logs",
	'  say "ERROR: the previous version did not come back. Restore .env.before-upgrade and run: docker compose up -d"',
	"  phase failed",
	`  exit ${UPDATER_EXIT.rollbackFailed}`,
	"}",
	`cd "$SB_DIR" || ${REFUSE}`,
	`[ -f .env ] || { say "ERROR: $SB_DIR/.env not found"; ${REFUSE}; }`,
	`docker image inspect "$SB_IMAGE_REPO:$SB_TARGET" >/dev/null 2>&1 || { say "ERROR: image $SB_IMAGE_REPO:$SB_TARGET is not on this host"; ${REFUSE}; }`,
	`cp -p .env .env.before-upgrade || ${REFUSE}`,
	"phase switching",
	'say "Switching $SB_APP_NAME $SB_PREVIOUS → $SB_TARGET..."',
	`set_version "$SB_TARGET" || { say "ERROR: could not write .env"; ${REFUSE}; }`,
	'if ! compose up -d --no-deps --pull never "$SB_SERVICE"; then say "ERROR: docker compose up failed"; rollback; fi',
	"phase health",
	'say "Waiting for the new panel to become healthy (at most $SB_HEALTH_TIMEOUT seconds; migrations run first)..."',
	'if wait_healthy "$SB_TARGET"; then say "$SB_APP_NAME $SB_TARGET is healthy."; phase succeeded; exit 0; fi',
	'say "The new version did not become healthy in time."',
	"show_logs",
	"rollback",
].join("\n");

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const HOST_PATH = /^\/[^\0\n\r:]*$/;

function assert(condition: boolean, message: string): void {
	if (!condition) throw internalError(`Invalid updater input: ${message}`);
}

/** Environment of the updater (validated). */
export function updaterEnv(input: UpdaterInput): Record<string, string> {
	const { install } = input;
	assert(IMAGE_TAG.test(input.targetVersion), "target version");
	assert(IMAGE_TAG.test(input.previousVersion), "previous version");
	assert(input.targetVersion !== input.previousVersion, "same version");
	assert(HOST_PATH.test(install.workingDir), "working dir");
	assert(
		install.configFiles.every((file) => HOST_PATH.test(file)),
		"files",
	);
	assert(SAFE_NAME.test(install.project), "project");
	assert(SAFE_NAME.test(install.service), "service");
	assert(/^[a-z0-9][a-z0-9._/:-]*$/.test(install.imageRepo), "image");
	for (const value of [
		input.healthTimeoutSeconds,
		input.healthPollSeconds,
		input.logTailLines,
	]) {
		assert(Number.isInteger(value) && value > 0, "timing");
	}
	return {
		SB_APP_NAME: APP_NAME,
		SB_DIR: install.workingDir,
		SB_PROJECT: install.project,
		SB_SERVICE: install.service,
		SB_CONTAINER: install.containerId,
		SB_IMAGE_REPO: install.imageRepo,
		SB_TARGET: input.targetVersion,
		SB_PREVIOUS: input.previousVersion,
		SB_HEALTH_TIMEOUT: String(input.healthTimeoutSeconds),
		SB_POLL_SECONDS: String(input.healthPollSeconds),
		SB_LOG_LINES: String(input.logTailLines),
		COMPOSE_FILE: install.configFiles.join(":"),
		COMPOSE_PATH_SEPARATOR: ":",
	};
}

/**
 * Host command starting the updater (detached; the panel follows it with
 * `docker logs` / `docker inspect`). The container is kept after it exits
 * so its log and exit code can be read; the panel removes it.
 *
 * Note: SB_CONTAINER is the panel's container *id* at start; compose
 * recreates the container under the same name, so the script looks it up
 * by name after the switch (see `updaterRunCommand`).
 */
export function updaterRunCommand(
	input: UpdaterInput,
	containerName: string,
): string {
	assert(SAFE_NAME.test(input.updaterContainer), "updater container");
	assert(SAFE_NAME.test(containerName), "panel container");
	assert(/^\/[\w./-]+$/.test(input.dockerSocket), "docker socket");
	assert(/^[\w-]+$/.test(input.deploymentId), "deployment id");
	assert(/^[\w-]+$/.test(input.instanceId), "instance id");
	const env = { ...updaterEnv(input), SB_CONTAINER: containerName };
	const dir = input.install.workingDir;
	return [
		"docker run -d",
		`--name ${q(input.updaterContainer)}`,
		`--label ${q(`${DOCKER_LABELS.upgrade}=${input.deploymentId}`)}`,
		`--label ${q(`${DOCKER_LABELS.instance}=${input.instanceId}`)}`,
		`-v ${q(`${input.dockerSocket}:/var/run/docker.sock`)}`,
		`-v ${q(`${dir}:${dir}`)}`,
		`-w ${q(dir)}`,
		...Object.entries(env).map(([key, value]) => `-e ${q(`${key}=${value}`)}`),
		"--entrypoint sh",
		q(input.updaterImage),
		"-c",
		q(UPDATER_SCRIPT),
	].join(" ");
}

/**
 * Before starting an updater: refuse while one runs under `name`, else
 * remove a finished one.
 */
export function updaterClearCommand(name: string): string {
	assert(SAFE_NAME.test(name), "updater container");
	const quoted = q(name);
	return `if [ "$(docker inspect -f '{{.State.Running}}' ${quoted} 2>/dev/null)" = true ]; then echo "an updater is already running" >&2; exit 1; fi; docker rm -f ${quoted} >/dev/null 2>&1; true`;
}

/** State of the updater container: `running|exited <exitCode>` or empty. */
export function updaterStateCommand(updaterContainer: string): string {
	assert(SAFE_NAME.test(updaterContainer), "updater container");
	return `docker inspect -f '{{.State.Status}} {{.State.ExitCode}} ${labelValueTemplate("upgrade")}' ${q(updaterContainer)} 2>/dev/null || true`;
}

export function parseUpdaterState(
	output: string,
): { status: string; exitCode: number; deploymentId: string } | null {
	const [status, code, deploymentId = ""] = output.trim().split(/\s+/);
	if (!status || code === undefined) return null;
	const exitCode = Number(code);
	return Number.isInteger(exitCode) ? { status, exitCode, deploymentId } : null;
}
