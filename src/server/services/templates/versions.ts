import type { TemplateVersion } from "#/features/templates/schema.ts";
import type { RawBranch, RawCommit, RawRelease, RawTag } from "./github";

const PRERELEASE = /(?:^|[-.])(alpha|beta|rc|pre|preview|canary|nightly|dev)/i;

export function versionsFromReleases(
	releases: RawRelease[],
): TemplateVersion[] {
	return releases
		.filter((release) => !release.draft)
		.map((release) => ({
			ref: release.tag_name,
			name: release.name || release.tag_name,
			publishedAt: release.published_at,
			prerelease: release.prerelease || PRERELEASE.test(release.tag_name),
			url: safeReleaseUrl(release.html_url),
		}));
}

/** Release pages are linked from the UI: https only. */
export function safeReleaseUrl(
	value: string | null | undefined,
): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.toString() : null;
	} catch {
		return null;
	}
}

export function versionsFromTags(tags: RawTag[]): TemplateVersion[] {
	return tags.map((tag) => ({
		ref: tag.name,
		name: tag.name,
		publishedAt: null,
		prerelease: PRERELEASE.test(tag.name),
	}));
}

/**
 * Branches named after versions (e.g. `v3.2.1`), newest version first
 * (GitHub lists branches alphabetically). Non-version branches sort last;
 * `version_filter` normally drops them.
 */
export function versionsFromBranches(branches: RawBranch[]): TemplateVersion[] {
	return branches
		.map((branch) => ({
			ref: branch.name,
			name: branch.name,
			publishedAt: null,
			prerelease: PRERELEASE.test(branch.name),
		}))
		.sort((a, b) => compareVersionNames(b.ref, a.ref));
}

const numbers = (value: string) =>
	(value.match(/\d+/g) ?? []).map((part) => Number(part));

function compareNumbers(left: number[], right: number[]): number {
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? -1) - (right[i] ?? -1);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Pre-release stages, earliest first (`alpha` < `beta` < `rc`). */
const PRERELEASE_STAGES = [
	["dev", "nightly", "canary"],
	["alpha"],
	["beta"],
	["pre", "preview"],
	["rc"],
];

function prereleaseStage(pre: string): number {
	const label = PRERELEASE.exec(pre)?.[1]?.toLowerCase() ?? "";
	return PRERELEASE_STAGES.findIndex((stage) => stage.includes(label));
}

/** `v1.2.0-rc1` -> core `v1.2.0`, pre-release `-rc1` (null without one). */
function splitPrerelease(value: string): { core: string; pre: string | null } {
	const match = PRERELEASE.exec(value);
	if (!match || !/\d/.test(value.slice(0, match.index))) {
		return { core: value, pre: null };
	}
	return { core: value.slice(0, match.index), pre: value.slice(match.index) };
}

/**
 * Numeric-aware comparison of version-like names (`v3.10.0` > `v3.9.1`); a
 * pre-release ranks below its release (`v1.2.0-rc1` < `v1.2.0`).
 */
export function compareVersionNames(a: string, b: string): number {
	const left = splitPrerelease(a);
	const right = splitPrerelease(b);
	const core = compareNumbers(numbers(left.core), numbers(right.core));
	if (core !== 0) return core;
	if (left.pre === null && right.pre !== null) return 1;
	if (left.pre !== null && right.pre === null) return -1;
	if (left.pre !== null && right.pre !== null) {
		const stage = prereleaseStage(left.pre) - prereleaseStage(right.pre);
		if (stage !== 0) return stage;
		const pre = compareNumbers(numbers(left.pre), numbers(right.pre));
		if (pre !== 0) return pre;
	}
	return a.localeCompare(b);
}

/** `${version_number}`: the ref without the template's prefix (e.g. `v`, `n8n@`). */
export function versionNumber(ref: string, prefix = "v"): string {
	return prefix &&
		ref.startsWith(prefix) &&
		/^\d/.test(ref.slice(prefix.length))
		? ref.slice(prefix.length)
		: ref;
}

export function versionsFromCommits(commits: RawCommit[]): TemplateVersion[] {
	return commits.map((commit) => ({
		ref: commit.sha,
		name: `${commit.sha.slice(0, 7)} ${commit.commit.message.split("\n")[0]}`.slice(
			0,
			120,
		),
		publishedAt: commit.commit.committer?.date ?? null,
		prerelease: false,
	}));
}

/** Which versions a template offers (`[source]` `version_filter`, `min_version`). */
export interface VersionOffer {
	filter?: string;
	/** Oldest version offered (named versions; compared numerically). */
	minVersion?: string;
}

/** The offer of a template source. */
export function versionOffer(source: {
	version_filter?: string;
	min_version?: string;
}): VersionOffer {
	return { filter: source.version_filter, minVersion: source.min_version };
}

/**
 * True when `ref` is offered: it matches the filter and is not older than
 * the minimum. (The prerelease toggle only hides versions from the list.)
 */
export function isVersionOffered(ref: string, offer: VersionOffer): boolean {
	if (offer.filter && !new RegExp(offer.filter).test(ref)) return false;
	return !offer.minVersion || compareVersionNames(ref, offer.minVersion) >= 0;
}

/**
 * Apply the template's offer (`version_filter`, `min_version`) and the
 * prerelease toggle. Order is preserved (GitHub returns newest first), so
 * `[0]` is the default version.
 */
export function filterVersions(
	versions: TemplateVersion[],
	options: VersionOffer & { includePrereleases?: boolean },
): TemplateVersion[] {
	return versions.filter(
		(version) =>
			isVersionOffered(version.ref, options) &&
			(options.includePrereleases || !version.prerelease),
	);
}

/** Latest stable offered version, or null when none match. */
export function defaultVersion(
	versions: TemplateVersion[],
	offer: VersionOffer = {},
): TemplateVersion | null {
	return (
		filterVersions(versions, { ...offer, includePrereleases: false })[0] ?? null
	);
}

/**
 * The template's `min_version` when `version` is below it (a new app of
 * that version cannot be deployed), else null. Commit sources have none.
 */
export function belowMinVersion(
	source: { versions: string; min_version?: string },
	version: string | null,
): string | null {
	const min = source.min_version;
	if (!min || !version || source.versions === "commits") return null;
	return isVersionOffered(version, { minVersion: min }) ? null : min;
}
