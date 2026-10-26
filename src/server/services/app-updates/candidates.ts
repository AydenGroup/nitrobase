import {
	compareVersionTags,
	type DatabaseEngineId,
	databaseEngines,
	databaseVersionRef,
	upgradeTargets,
} from "#/config/database-engines.ts";
import { commitPathByHost, defaultCommitPath } from "#/config/git-hosts.ts";
import type { TemplateVersion } from "#/features/templates/schema.ts";
import { updateKind } from "#/libs/semver.ts";
import { compareVersionNames } from "#/server/services/templates/versions.ts";
import type { AppUpdateKind } from "./policy";

/**
 * "Is there something newer than what runs?" per version source (pure).
 * Only versions NEWER than the deployed one are offered: a list whose
 * newest entry is older (yanked release, filtered tag) offers nothing.
 */
export interface UpdateCandidate {
	/** What the update deploys: template ref, `engine@tag`, commit SHA. */
	version: string;
	name: string;
	/** Release notes (https), when the source has them. */
	url: string | null;
	publishedAt: string | null;
	kind: AppUpdateKind;
}

/**
 * Template sources. `versions` is the template's list of stable versions,
 * newest first (what the wizard offers as the default); `commits` sources
 * compare commit SHAs instead of version names.
 */
export function newerTemplateVersion(input: {
	versions: TemplateVersion[];
	current: string;
	currentCommit: string | null;
	commits: boolean;
}): UpdateCandidate | null {
	const latest = input.versions[0];
	if (!latest) return null;
	const candidate = (kind: AppUpdateKind): UpdateCandidate => ({
		version: latest.ref,
		// The ref, not the release title ("v1.2.3 Release"): shown as from → to.
		name: input.commits
			? `${latest.ref.slice(0, 12)} ${latest.name.split(" ").slice(1).join(" ")}`.trim()
			: latest.ref,
		url: latest.url ?? null,
		publishedAt: latest.publishedAt,
		kind,
	});
	if (input.commits) {
		if (latest.ref === input.current || latest.ref === input.currentCommit) {
			return null;
		}
		// A deployed commit still in the list but not first = behind; one
		// that fell off the list is older than every listed commit.
		return candidate("commit");
	}
	if (latest.ref === input.current) return null;
	const kind = updateKind(input.current, latest.ref);
	if (kind) return candidate(kind);
	// Not semver on one side: newer by numeric-aware name only.
	const bothParse =
		/\d/.test(input.current) &&
		/\d/.test(latest.ref) &&
		compareVersionNames(latest.ref, input.current) > 0;
	return bothParse ? candidate("unknown") : null;
}

/**
 * An update target of a template app must be one of the source's listed
 * versions (the cached list) and newer than what runs: a request cannot
 * smuggle an arbitrary ref or a downgrade through "update".
 */
export function isTemplateTarget(input: {
	versions: TemplateVersion[];
	current: string;
	currentCommit: string | null;
	commits: boolean;
	target: string;
}): boolean {
	if (!input.versions.some((version) => version.ref === input.target)) {
		return false;
	}
	if (input.commits) {
		return (
			input.target !== input.current && input.target !== input.currentCommit
		);
	}
	if (input.target === input.current) return false;
	return (
		updateKind(input.current, input.target) !== null ||
		(updateKind(input.target, input.current) === null &&
			compareVersionNames(input.target, input.current) > 0)
	);
}

/** Databases: the newest image tag the engine allows in place. */
export function newerDatabaseVersion(
	engine: DatabaseEngineId,
	tag: string,
): UpdateCandidate | null {
	const [best] = [...upgradeTargets(engine, tag)].sort((a, b) =>
		compareVersionTags(b.tag, a.tag),
	);
	if (!best) return null;
	return {
		version: databaseVersionRef(engine, best.tag),
		name: `${databaseEngines[engine].name} ${best.tag}`,
		url: null,
		publishedAt: null,
		kind: updateKind(tag, best.tag) ?? "unknown",
	};
}

/** Git apps: the branch tip, when it is not the deployed commit. */
export function newerCommit(input: {
	tip: string;
	deployed: string | null;
	branch: string;
	/** Web page of a commit (`{sha}` placeholder), when the host has one. */
	commitUrl: string | null;
}): UpdateCandidate | null {
	if (!/^[0-9a-f]{40}$/.test(input.tip) || input.tip === input.deployed) {
		return null;
	}
	return {
		version: input.tip,
		name: `${input.branch}@${input.tip.slice(0, 12)}`,
		url: input.commitUrl ? input.commitUrl.replace("{sha}", input.tip) : null,
		publishedAt: null,
		kind: "commit",
	};
}

/**
 * Commit page of an https repository URL (paths from
 * `#/config/git-hosts.ts`); null for SSH URLs or URLs with credentials.
 */
export function commitUrlTemplate(repoUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(repoUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password) return null;
	const repoPath = url.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
	if (!/^\/[\w.-]+\/[\w.-]+(\/[\w.-]+)*$/.test(repoPath)) return null;
	const commitPath = commitPathByHost[url.hostname] ?? defaultCommitPath;
	return `https://${url.host}${repoPath}${commitPath}`;
}
