import { VERSION_ENV_NAME } from "#/config/shared.ts";
import { IMAGE_TAG } from "./releases";

/**
 * Where and how this panel is installed (pure): read from `docker inspect`
 * of the panel container, as seen from the host. The in-panel upgrade
 * works only for the compose install the installer creates: a container
 * of a compose project whose image is `<repo>:<NITROBASE_VERSION>` and
 * that has a health check (the updater waits for it).
 */
export interface PanelInstall {
	containerId: string;
	/** `repo:tag` the container runs. */
	image: string;
	imageRepo: string;
	imageTag: string;
	project: string;
	service: string;
	/** Compose project directory on the host (holds `.env`). */
	workingDir: string;
	/** Compose files (absolute host paths). */
	configFiles: string[];
}

export type InstallProblem =
	/** Nitrobase does not run in a container (development). */
	| "not_container"
	/** No container with PANEL_CONTAINER's name on the host. */
	| "not_found"
	/** The container named PANEL_CONTAINER is not this process. */
	| "not_this_container"
	/** Not started by docker compose. */
	| "not_compose"
	/** The image has no version tag (built locally, `latest`, digest). */
	| "image_unpinned"
	/** No health check: the updater could not tell a broken version. */
	| "no_healthcheck"
	/** `.env` has no NITROBASE_VERSION (the image is not chosen there). */
	| "env_missing";

interface InspectShape {
	Id?: string;
	Name?: string;
	Config?: {
		Image?: string;
		Hostname?: string;
		Labels?: Record<string, string> | null;
		Healthcheck?: { Test?: string[] | null } | null;
	};
}

/** Host paths compose reports: absolute, no `:` (COMPOSE_FILE separator) or control chars. */
const HOST_PATH = /^\/[^\0\n\r:]*$/;

/** Split `repo[:tag]` (a registry port is not a tag). */
export function splitImage(image: string): {
	repo: string;
	tag: string | null;
} {
	if (image.includes("@")) return { repo: image.split("@")[0], tag: null };
	const slash = image.lastIndexOf("/");
	const colon = image.lastIndexOf(":");
	if (colon > slash) {
		return { repo: image.slice(0, colon), tag: image.slice(colon + 1) };
	}
	return { repo: image, tag: null };
}

export function detectInstall(input: {
	/** `docker inspect` JSON of PANEL_CONTAINER (null: not found). */
	inspect: string | null;
	/** os.hostname() of this process (a container's id prefix). */
	hostname: string;
	inContainer: boolean;
}): { install: PanelInstall } | { problem: InstallProblem } {
	if (!input.inContainer) return { problem: "not_container" };
	if (!input.inspect) return { problem: "not_found" };
	let parsed: InspectShape | undefined;
	try {
		const value = JSON.parse(input.inspect) as InspectShape[] | InspectShape;
		parsed = Array.isArray(value) ? value[0] : value;
	} catch {
		return { problem: "not_found" };
	}
	if (!parsed?.Id || !parsed.Config) return { problem: "not_found" };
	const id = parsed.Id;
	if (
		parsed.Config.Hostname !== input.hostname &&
		!id.startsWith(input.hostname)
	) {
		return { problem: "not_this_container" };
	}
	const labels = parsed.Config.Labels ?? {};
	const project = labels["com.docker.compose.project"];
	const service = labels["com.docker.compose.service"];
	const workingDir = labels["com.docker.compose.project.working_dir"];
	const configFiles = (labels["com.docker.compose.project.config_files"] ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	if (
		!project ||
		!service ||
		!workingDir ||
		!HOST_PATH.test(workingDir) ||
		configFiles.length === 0 ||
		!configFiles.every((file) => HOST_PATH.test(file))
	) {
		return { problem: "not_compose" };
	}
	const image = parsed.Config.Image ?? "";
	const { repo, tag } = splitImage(image);
	if (!tag || tag === "latest" || repo === "sha256" || !IMAGE_TAG.test(tag)) {
		return { problem: "image_unpinned" };
	}
	const test = parsed.Config.Healthcheck?.Test ?? [];
	if (test.length === 0 || test[0] === "NONE") {
		return { problem: "no_healthcheck" };
	}
	return {
		install: {
			containerId: id,
			image,
			imageRepo: repo,
			imageTag: tag,
			project,
			service,
			workingDir,
			configFiles,
		},
	};
}

/**
 * POSIX (grep -E / sed -E) pattern of an assignment line of `name`, the
 * same leading/around-`=` whitespace tolerance as `envVersion`: the
 * panel's detection and the updater's rewrite agree on which line counts.
 */
export const versionLineEre = (name: string) =>
	`^[[:space:]]*${name}[[:space:]]*=`;

/** The `VERSION_ENV_NAME` line (grep -E). */
export const VERSION_LINE_ERE = versionLineEre(VERSION_ENV_NAME);

/** Last assignment of `name` in `.env` text (empty: null). */
function envValue(envText: string, name: string): string | null {
	const line = new RegExp(`^\\s*${name}\\s*=\\s*["']?([^"'\\s#]*)["']?\\s*$`);
	let value: string | null = null;
	for (const text of envText.split("\n")) {
		const match = line.exec(text);
		if (match) value = match[1] || null;
	}
	return value;
}

/** The image tag from the install's `.env` text (last assignment wins). */
export function envVersion(envText: string): string | null {
	return envValue(envText, VERSION_ENV_NAME);
}
