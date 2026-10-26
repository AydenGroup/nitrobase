import { compareSemVer, isPrerelease, parseVersion } from "#/libs/semver.ts";
import type { RawRelease } from "#/server/services/templates/github.ts";
import { safeReleaseUrl } from "#/server/services/templates/versions.ts";

/**
 * Nitrobase release selection (pure): which published release is the
 * newest for the configured channel, and whether it is newer than this
 * build. Releases come from the GitHub (or Gitea-compatible) releases API.
 */
export type ReleaseChannel = "stable" | "prerelease";

export interface ReleaseInfo {
	/** Git tag (`v1.2.3`). */
	tag: string;
	/** Version without a leading "v" (`1.2.3`): the image tag. */
	version: string;
	name: string;
	/** Release notes page (https only). */
	url: string | null;
	publishedAt: string | null;
	prerelease: boolean;
}

/** Image tag of a release tag: a leading "v" is dropped. */
export function imageTagOf(tag: string): string {
	return /^v\d/.test(tag) ? tag.slice(1) : tag;
}

/** Docker image tag rules (what `docker pull repo:<tag>` accepts). */
export const IMAGE_TAG = /^[\w][\w.-]{0,127}$/;

function toReleaseInfo(release: RawRelease): ReleaseInfo | null {
	const version = imageTagOf(release.tag_name);
	if (!IMAGE_TAG.test(version) || !parseVersion(version)) return null;
	return {
		tag: release.tag_name,
		version,
		name: release.name || release.tag_name,
		url: safeReleaseUrl(release.html_url),
		publishedAt: release.published_at,
		prerelease: release.prerelease || isPrerelease(version),
	};
}

/** Newest release of the channel (drafts and unparseable tags ignored). */
export function pickLatestRelease(
	releases: RawRelease[],
	channel: ReleaseChannel,
): ReleaseInfo | null {
	let best: ReleaseInfo | null = null;
	for (const raw of releases) {
		if (raw.draft) continue;
		const info = toReleaseInfo(raw);
		if (!info) continue;
		if (info.prerelease && channel === "stable") continue;
		const parsed = parseVersion(info.version);
		const current = best ? parseVersion(best.version) : null;
		if (parsed && (!current || compareSemVer(parsed, current) > 0)) {
			best = info;
		}
	}
	return best;
}

/** Whether `latest` is newer than the running `current` version. */
export function isNewerRelease(
	current: string,
	latest: ReleaseInfo | null,
): boolean {
	if (!latest) return false;
	const a = parseVersion(current);
	const b = parseVersion(latest.version);
	if (!b) return false;
	// A build without a usable version (dev) is never offered an upgrade
	// it could not compare against.
	return !!a && compareSemVer(b, a) > 0;
}

/** A release the instance may upgrade to (exact tag from the release list). */
export function findRelease(
	releases: RawRelease[],
	version: string,
): ReleaseInfo | null {
	for (const raw of releases) {
		if (raw.draft) continue;
		const info = toReleaseInfo(raw);
		if (info && info.version === version) return info;
	}
	return null;
}

/**
 * The GitHub token goes only to the GitHub API itself (a Gitea/Forgejo
 * release host must never receive it).
 */
export function sendsGitHubToken(
	apiUrl: string,
	githubApiUrl: string,
): boolean {
	const normalize = (value: string) => value.trim().replace(/\/+$/, "");
	return normalize(apiUrl) === normalize(githubApiUrl);
}
