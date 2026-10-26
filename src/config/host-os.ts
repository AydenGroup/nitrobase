import { shellQuote } from "#/server/services/executor.ts";
import { getConfig } from "./server";

/**
 * Linux families bootstrap can set up (server-only). Each declares the
 * `/etc/os-release` ids it covers, its package manager and how it installs
 * packages and Docker; bootstrap picks the family from the probed ids and
 * never branches on a distribution. Adding a family (RHEL, Alpine…) = one
 * entry here.
 */
export interface HostOsFamily {
	/**
	 * `ID` values of `/etc/os-release` it supports (not `ID_LIKE`:
	 * derivatives use their own package repositories).
	 */
	osIds: readonly string[];
	/** Package manager command (probed: missing = unusable host). */
	packageManager: string;
	/** Non-interactive install of `packages`. */
	installPackagesScript(packages: readonly string[]): string;
	/** Docker Engine with the compose and buildx plugins, enabled and started. */
	installDockerScript(): string;
	/** Progress chatter of the package manager, dropped from job logs. */
	noise: RegExp;
}

/** Tools bootstrap needs on every host (package names shared by the families). */
export const BASE_PACKAGES = [
	"ca-certificates",
	"curl",
	"wget",
	"git",
	"jq",
	"openssl",
] as const;

/** Commands the base packages provide (all present: nothing to install). */
export const BASE_COMMANDS = ["curl", "wget", "git", "jq", "openssl"] as const;

const APT = "DEBIAN_FRONTEND=noninteractive apt-get";

export const hostOsFamilies = {
	debian: {
		osIds: ["ubuntu", "debian"],
		packageManager: "apt-get",
		installPackagesScript: (packages) =>
			`${APT} update -qq && ${APT} install -y -qq ${packages.join(" ")}`,
		installDockerScript: () => {
			const config = getConfig();
			return `
		set -e
		export DEBIAN_FRONTEND=noninteractive
		distro=$(grep '^ID=' /etc/os-release | cut -d= -f2 | tr -d '"')
		repo=${shellQuote(config.DOCKER_APT_REPO_URL)}/"$distro"
		keyring=${shellQuote(config.DOCKER_APT_KEYRING)}
		apt-get update -qq
		apt-get install -y -qq ca-certificates curl gnupg
		install -m 0755 -d "$(dirname "$keyring")"
		curl -fsSL "$repo/gpg" | gpg --batch --yes --dearmor -o "$keyring"
		chmod a+r "$keyring"
		echo "deb [arch=$(dpkg --print-architecture) signed-by=$keyring] $repo $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
		apt-get update -qq
		apt-get install -y -qq ${config.DOCKER_PACKAGES.map(shellQuote).join(" ")}
		systemctl enable docker
		systemctl start docker
	`;
		},
		noise:
			/^(\(Reading database|Reading database|Selecting previously unselected|Preparing to unpack|Unpacking |Processing triggers|Get:\d|Hit:\d|Ign:\d|Fetched |Reading package lists|Building dependency tree|Reading state information|debconf: |dpkg-preconfigure: |update-alternatives: |Created symlink |Synchronizing state|Executing: |invoke-rc\.d: |\/usr\/sbin\/policy-rc\.d)/,
	},
} as const satisfies Record<string, HostOsFamily>;

/** Every supported `/etc/os-release` id (error messages, docs). */
export const SUPPORTED_OS_IDS: readonly string[] = Object.values(
	hostOsFamilies,
).flatMap((family) => family.osIds);

/** The family of a host from its `/etc/os-release` ID (null: unsupported). */
export function hostOsFamily(osId: string): HostOsFamily | null {
	return (
		(Object.values(hostOsFamilies) as HostOsFamily[]).find((family) =>
			family.osIds.includes(osId),
		) ?? null
	);
}
