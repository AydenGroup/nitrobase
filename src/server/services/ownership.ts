import {
	DOCKER_LABELS,
	hiddenFileName,
	labelValueTemplate,
} from "#/config/identifiers.ts";
import { internalError } from "#/utils/error.ts";

/** POSIX sh quoting (same as `shellQuote`; no executor import keeps this pure). */
const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Instance ownership of resources on a server. Several Nitrobase panels (or
 * a reinstalled panel with a fresh database) may see the same box, so every
 * resource Nitrobase creates carries the id of the instance that created it
 * (the J-g instance identity):
 * - containers: label `nitrobase.instance` (compose transform, Traefik);
 * - app folders: a marker file at the folder's top (`APP_OWNER_FILE`);
 * - the managed root (Traefik, routes): `<NITROBASE_ROOT>/instance-id`.
 *
 * Named volumes carry no instance label: Docker volume labels are
 * immutable and compose asks to *recreate* (data loss) a volume whose
 * labels changed. A volume's owner is its compose project's owner.
 *
 * Only resources owned by this instance are ever wiped from the UI.
 * Pure (commands are unit-tested).
 */

/** Container label holding the owning instance id. */
export const OWNER_LABEL = DOCKER_LABELS.instance;
/** Marker file at the top of an app folder (reserved: never mountable). */
export const APP_OWNER_FILE = hiddenFileName("instance");
/** Marker file of the managed root, relative to NITROBASE_ROOT. */
const ROOT_OWNER_FILE = "instance-id";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Placeholder printed by scans for "no owner recorded". */
const NONE = "-";

export function isInstanceId(value: string): boolean {
	return ID_PATTERN.test(value);
}

function assertId(id: string): string {
	if (!isInstanceId(id)) throw internalError("Invalid instance id");
	return id;
}

/**
 * Shell snippet printing a marker file's id (or `-`), never following a
 * symlink. `file` is a shell word (already quoted).
 */
export function readMarkerSnippet(file: string): string {
	return `if [ -f ${file} ] && [ ! -L ${file} ]; then o=$(head -c 128 ${file} | tr -cd 'A-Za-z0-9_-'); echo "\${o:-${NONE}}"; else echo ${NONE}; fi`;
}

/**
 * Write `id` into `file` atomically, replacing (not following) a symlink.
 * The parent must exist (an app folder or the managed root).
 */
export function writeMarkerScript(file: string, id: string): string {
	const f = q(file);
	// A subshell: `exit 0` (missing parent) only ends this write.
	return [
		"(",
		`dir=$(dirname -- ${f})`,
		'[ -d "$dir" ] && [ ! -L "$dir" ] || exit 0',
		`tmp=$(mktemp -- "$dir/${hiddenFileName("owner")}.XXXXXX")`,
		`printf '%s\\n' ${q(assertId(id))} > "$tmp"`,
		'chmod 0644 -- "$tmp"',
		`mv -fT -- "$tmp" ${f}`,
		")",
	].join("\n");
}

/** Owner of the managed root and of the Traefik container (`key=value` lines). */
export function serverOwnershipScript(root: string, traefik: string): string {
	return [
		`echo "root_owner=$(${readMarkerSnippet(q(`${root}/${ROOT_OWNER_FILE}`))})"`,
		`echo "traefik_owner=$(docker inspect -f '${labelValueTemplate("instance")}' ${q(traefik)} 2>/dev/null | tr -cd 'A-Za-z0-9_-')"`,
	].join("\n");
}

export interface ServerOwnership {
	/** Ids recorded on the server that are not this instance's. */
	foreign: string[];
	/** This instance's id is recorded (root marker or Traefik label). */
	claimed: boolean;
}

export function evaluateServerOwnership(
	values: Record<string, string>,
	instanceId: string,
): ServerOwnership {
	const ids = [values.root_owner, values.traefik_owner].filter(
		(value): value is string => !!value && value !== NONE,
	);
	return {
		foreign: [...new Set(ids.filter((id) => id !== instanceId))],
		claimed: ids.includes(instanceId),
	};
}

/**
 * Claim the managed root for `id` and mark the folders of this instance's
 * apps (older installs adopt their existing resources). Only existing
 * folders are marked; nothing is created.
 */
export function claimServerScript(
	root: string,
	appsRoot: string,
	folders: string[],
	id: string,
): string {
	const lines = [writeMarkerScript(`${root}/${ROOT_OWNER_FILE}`, id)];
	for (const folder of folders) {
		lines.push(
			writeMarkerScript(`${appsRoot}/${folder}/${APP_OWNER_FILE}`, id),
		);
	}
	return lines.join("\n");
}
