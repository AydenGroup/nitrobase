/**
 * Loose semantic versions (client-safe, pure). Release tags and image tags
 * are often "almost semver": `v1.2.3`, `n8n@1.2.3`, `1.2`, `0.1.0.beta`,
 * `2.41.6-alpine`. `parseVersion` reads the first `major[.minor[.patch]]`
 * run after an optional prefix, and keeps what follows as the pre-release
 * (unless it looks like a build/variant suffix such as `-alpine`).
 *
 * Used by the Nitrobase update check and by app update policies
 * (auto-update patch / minor releases).
 */
export interface SemVer {
	major: number;
	minor: number;
	patch: number;
	/** Pre-release identifiers (`rc.1`), empty for a release. */
	prerelease: string[];
	/** Whether minor/patch were written (`1.2` has no patch). */
	parts: 1 | 2 | 3;
}

/** Labels that mark a pre-release (the rest of a suffix is a variant). */
const PRERELEASE_LABEL =
	/^(alpha|beta|rc|pre|preview|canary|nightly|dev|next)/i;

const VERSION =
	/^(?:[A-Za-z][\w.-]*?[@-]|v|V)?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.+]?(.*))?$/;

export function parseVersion(value: string): SemVer | null {
	const text = value.trim();
	const match = VERSION.exec(text);
	if (!match) return null;
	const [, major, minor, patch, rest = ""] = match;
	const numbers = [major, minor, patch].map((part) =>
		part === undefined ? undefined : Number(part),
	);
	if (numbers.some((part) => part !== undefined && !Number.isSafeInteger(part)))
		return null;
	// Build metadata (`+…`) never counts; a suffix is a pre-release only when
	// it starts with a known label (`-rc.1`, `.beta`), else it is a variant.
	const suffix = rest.split("+")[0] ?? "";
	const prerelease =
		suffix && PRERELEASE_LABEL.test(suffix)
			? suffix.split(/[.-]/).filter(Boolean)
			: [];
	return {
		major: numbers[0] as number,
		minor: numbers[1] ?? 0,
		patch: numbers[2] ?? 0,
		prerelease,
		parts: patch !== undefined ? 3 : minor !== undefined ? 2 : 1,
	};
}

function comparePrerelease(a: string[], b: string[]): number {
	// A release sorts after its pre-releases.
	if (!a.length || !b.length) return (b.length ? 1 : 0) - (a.length ? 1 : 0);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const left = a[i];
		const right = b[i];
		if (left === undefined) return -1;
		if (right === undefined) return 1;
		const ln = /^\d+$/.test(left) ? Number(left) : null;
		const rn = /^\d+$/.test(right) ? Number(right) : null;
		if (ln !== null && rn !== null) {
			if (ln !== rn) return ln - rn;
		} else if (ln !== null) return -1;
		else if (rn !== null) return 1;
		else if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}

/** Order of two parsed versions (negative: `a` is older). */
export function compareSemVer(a: SemVer, b: SemVer): number {
	return (
		a.major - b.major ||
		a.minor - b.minor ||
		a.patch - b.patch ||
		comparePrerelease(a.prerelease, b.prerelease)
	);
}

export function isPrerelease(value: string): boolean {
	return (parseVersion(value)?.prerelease.length ?? 0) > 0;
}

/** How far apart two versions are, from the older one's point of view. */
export type UpdateKind = "major" | "minor" | "patch" | "prerelease";

/**
 * The kind of update from `from` to `to`; null when `to` is not newer or a
 * version does not parse.
 */
export function updateKind(from: string, to: string): UpdateKind | null {
	const a = parseVersion(from);
	const b = parseVersion(to);
	if (!a || !b || compareSemVer(b, a) <= 0) return null;
	if (b.major !== a.major) return "major";
	if (b.minor !== a.minor) return "minor";
	if (b.patch !== a.patch) return "patch";
	return "prerelease";
}

/** A commit SHA (short or full): never read as a version number. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Whether moving from `from` to `to` goes back to an older release. Only
 * claimed when both read as versions with at least `major.minor` (a bare
 * number, a branch name or a commit SHA says nothing about order).
 */
export function isDowngrade(from: string, to: string): boolean {
	if (COMMIT_SHA.test(from.trim()) || COMMIT_SHA.test(to.trim())) return false;
	const a = parseVersion(from);
	const b = parseVersion(to);
	if (!a || !b || a.parts < 2 || b.parts < 2) return false;
	return compareSemVer(b, a) < 0;
}
