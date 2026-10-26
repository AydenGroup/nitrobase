import { asList, type ErrorInfo } from "#/libs/coded.ts";
import { coded } from "#/utils/error.ts";
import { diskBlocker } from "./preflight";

/**
 * Appwrite: what a preflight found, turned into blockers and warnings
 * (pure; the facts come from the driver).
 */

/**
 * Numeric comparison of release versions (`1.8.0` < `2.3.0`; a
 * pre-release suffix sorts before its release). Null when either is not a
 * version.
 */
export function compareReleases(a: string, b: string): number | null {
	const parse = (value: string) => {
		const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(
			value.trim(),
		);
		if (!match) return null;
		return {
			numbers: [match[1], match[2], match[3]].map((part) => Number(part ?? 0)),
			pre: match[4] ?? null,
		};
	};
	const left = parse(a);
	const right = parse(b);
	if (!left || !right) return null;
	for (let i = 0; i < 3; i++) {
		const diff = left.numbers[i] - right.numbers[i];
		if (diff !== 0) return Math.sign(diff);
	}
	if (left.pre === right.pre) return 0;
	if (left.pre === null) return 1;
	if (right.pre === null) return -1;
	return comparePrerelease(left.pre, right.pre);
}

/**
 * Semver pre-release order: dot-separated identifiers, numeric ones
 * compared as numbers and lower than alphanumeric ones; a shorter list
 * that is a prefix sorts first (`rc.9` < `rc.10` < `rc.10.1`).
 */
function comparePrerelease(a: string, b: string): number {
	const left = a.split(".");
	const right = b.split(".");
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const x = left[i];
		const y = right[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const xNumeric = /^\d+$/.test(x);
		const yNumeric = /^\d+$/.test(y);
		if (xNumeric && yNumeric) {
			const diff = Number(x) - Number(y);
			if (diff !== 0) return Math.sign(diff);
		} else if (xNumeric !== yNumeric) {
			return xNumeric ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

/**
 * Whether `local` is newer than `cloud` by a minor version or more (the
 * cloud's migration reads the app with its own client: a newer API may
 * not be understood; patch releases do not change it). Null: either is
 * not a version.
 */
export function newerByMinor(local: string, cloud: string): boolean | null {
	const minor = (value: string) => {
		const match = /^v?(\d+)(?:\.(\d+))?/.exec(value.trim());
		return match ? `${match[1]}.${match[2] ?? "0"}.0` : null;
	};
	const left = minor(local);
	const right = minor(cloud);
	if (!left || !right) return null;
	const order = compareReleases(left, right);
	return order === null ? null : order > 0;
}

/** Whether the app answers on its public address (export reachability). */
export type Reachability =
	| { kind: "ok" }
	| { kind: "skipped" }
	| { kind: "no_url" }
	| { kind: "unreachable"; url: string; detail: string }
	| { kind: "mismatch"; url: string; found: string };

export interface AppwriteExportFacts {
	parts: string[];
	cloudProjectId: string;
	localProjectId: string;
	/** The app's Appwrite version (null: unknown). */
	localVersion: string | null;
	cloudVersion: string;
	/** What the cloud project holds, per resource (an export needs 0). */
	cloud: Record<string, number>;
	/** Cloud resources the key could not count (emptiness unknown). */
	cloudRefused: string[];
	/** The cloud key may start migrations (null: not known). */
	canWrite: boolean | null;
	cloudScopes: string[];
	reachability: Reachability;
	/** The member gave the app's key (handed to the cloud). */
	givenKey: boolean;
	/** The app's resources the export could not count. */
	refused: string[];
	partial: boolean;
}

export function analyzeAppwriteExport(facts: AppwriteExportFacts): {
	blockers: ErrorInfo[];
	warnings: ErrorInfo[];
	requiredDiskBytes: number;
} {
	const blockers: ErrorInfo[] = [];
	const warnings: ErrorInfo[] = [];
	if (facts.parts.length === 0) blockers.push(coded("CLOUD_SYNC_PARTS_EMPTY"));
	const items = Object.entries(facts.cloud)
		.filter(([, count]) => count > 0)
		.map(([resource, count]) => `${resource}: ${count}`);
	if (items.length > 0) {
		blockers.push(coded("CLOUD_EXPORT_NOT_EMPTY", { items: asList(items) }));
	}
	if (facts.cloudRefused.length > 0) {
		blockers.push(
			coded("CLOUD_EXPORT_EMPTINESS_UNKNOWN", {
				detail: facts.cloudRefused.join(", "),
			}),
		);
	}
	if (facts.canWrite === false) {
		blockers.push(
			coded("CLOUD_EXPORT_KEY_NO_WRITE", { scopes: asList(facts.cloudScopes) }),
		);
	}
	if (facts.localVersion === null) {
		blockers.push(coded("CLOUD_SYNC_VERSION_UNKNOWN"));
	} else {
		const newer = newerByMinor(facts.localVersion, facts.cloudVersion);
		if (newer === null) blockers.push(coded("CLOUD_SYNC_VERSION_UNKNOWN"));
		else if (newer) {
			blockers.push(
				coded("CLOUD_EXPORT_RELEASE_NEWER", {
					source: facts.localVersion,
					target: facts.cloudVersion,
				}),
			);
		}
	}
	const reach = facts.reachability;
	if (reach.kind === "no_url")
		blockers.push(coded("CLOUD_EXPORT_NO_PUBLIC_URL"));
	if (reach.kind === "unreachable") {
		blockers.push(
			coded("CLOUD_EXPORT_SOURCE_UNREACHABLE", {
				url: reach.url,
				detail: reach.detail,
			}),
		);
	}
	if (reach.kind === "mismatch") {
		blockers.push(
			coded("CLOUD_EXPORT_SOURCE_MISMATCH", {
				url: reach.url,
				expected: facts.localVersion ?? "",
				found: reach.found,
			}),
		);
	}
	if (reach.kind === "skipped") {
		warnings.push(coded("CLOUD_WARN_EXPORT_REACHABILITY_SKIPPED"));
	}
	warnings.push(
		coded("CLOUD_WARN_APPWRITE_EXPORT_ENDPOINT", {
			project: facts.cloudProjectId,
			local: facts.localProjectId,
		}),
	);
	warnings.push(coded("CLOUD_WARN_APPWRITE_SESSIONS"));
	warnings.push(coded("CLOUD_WARN_APPWRITE_EXPORT_REDO"));
	warnings.push(coded("CLOUD_WARN_APPWRITE_EXPORT_LIVE"));
	if (facts.givenKey)
		warnings.push(coded("CLOUD_WARN_APPWRITE_EXPORT_GIVEN_KEY"));
	if (facts.refused.length > 0) {
		warnings.push(
			coded("CLOUD_WARN_APPWRITE_UNCOUNTED", {
				resources: asList([...new Set(facts.refused)]),
			}),
		);
	}
	if (facts.partial) warnings.push(coded("CLOUD_WARN_APPWRITE_COUNTS_PARTIAL"));
	return { blockers, warnings, requiredDiskBytes: 0 };
}

export interface AppwritePreflightFacts {
	projectId: string;
	sourceVersion: string;
	/** Release the new app deploys (null: unknown). */
	targetVersion: string | null;
	/** Bytes the copy writes on the server (files). */
	copyBytes: number;
	freeDiskBytes: number | null;
	diskFactor: number;
	functionCount: number;
	/** Resources the key could not read. */
	refused: string[];
	/** Some counts are lower bounds. */
	partial: boolean;
	wantsFunctions: boolean;
}

export function analyzeAppwritePreflight(facts: AppwritePreflightFacts): {
	blockers: ErrorInfo[];
	warnings: ErrorInfo[];
	requiredDiskBytes: number;
} {
	const blockers: ErrorInfo[] = [];
	const warnings: ErrorInfo[] = [];
	if (facts.targetVersion === null) {
		blockers.push(coded("CLOUD_SYNC_RELEASE_UNKNOWN"));
	} else {
		const order = compareReleases(facts.sourceVersion, facts.targetVersion);
		if (order === null) {
			blockers.push(coded("CLOUD_SYNC_VERSION_UNKNOWN"));
		} else if (order > 0) {
			blockers.push(
				coded("CLOUD_SYNC_RELEASE_OLDER", {
					source: facts.sourceVersion,
					target: facts.targetVersion,
				}),
			);
		}
	}
	const requiredDiskBytes = Math.ceil(facts.copyBytes * facts.diskFactor);
	const disk = diskBlocker(requiredDiskBytes, facts.freeDiskBytes);
	if (disk) blockers.push(disk);

	warnings.push(
		coded("CLOUD_WARN_APPWRITE_ENDPOINT", { project: facts.projectId }),
	);
	warnings.push(coded("CLOUD_WARN_APPWRITE_SESSIONS"));
	warnings.push(coded("CLOUD_WARN_APPWRITE_SECRETS"));
	if (facts.wantsFunctions && facts.functionCount > 0) {
		warnings.push(
			coded("CLOUD_WARN_APPWRITE_FUNCTIONS_DISABLED", {
				count: facts.functionCount,
			}),
		);
	}
	if (facts.refused.length > 0) {
		warnings.push(
			coded("CLOUD_WARN_APPWRITE_UNCOUNTED", {
				resources: asList([...new Set(facts.refused)]),
			}),
		);
	}
	if (facts.partial) warnings.push(coded("CLOUD_WARN_APPWRITE_COUNTS_PARTIAL"));
	warnings.push(coded("CLOUD_WARN_APPWRITE_DEDICATED_KEY"));
	warnings.push(coded("CLOUD_WARN_APPWRITE_FREE_QUOTA"));
	warnings.push(coded("CLOUD_WARN_APPWRITE_NOT_IN_SCOPE"));
	return { blockers, warnings, requiredDiskBytes };
}
