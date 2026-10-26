import type { ReleaseStatus } from "#/features/git/schema.ts";

/**
 * Image retention and rollback choice for git apps (pure).
 *
 * Kept: the live image plus the `keep` most recently used ready releases
 * (last deployed, else built). Everything else of the app's image repo
 * (`<folder>:*`) is pruned, including images whose release row is gone.
 * Docker itself refuses to remove an image a container still uses (no
 * `-f`), which is the last guard against removing what runs.
 */
export interface ReleaseRef {
	id: string;
	commitSha: string;
	imageTag: string;
	status: ReleaseStatus;
	lastDeployedAt: Date | null;
	createdAt: Date;
}

const recency = (release: ReleaseRef) =>
	(release.lastDeployedAt ?? release.createdAt).getTime();

/** Releases whose image stays (the live one first). */
export function releasesToKeep(
	releases: ReleaseRef[],
	liveSha: string | null,
	keep: number,
): ReleaseRef[] {
	const ready = releases
		.filter((release) => release.status === "ready")
		.sort((a, b) => recency(b) - recency(a));
	const live = ready.find((release) => release.commitSha === liveSha);
	const others = ready.filter((release) => release !== live);
	const slots = Math.max(0, Math.floor(keep) - (live ? 1 : 0));
	return [...(live ? [live] : []), ...others.slice(0, slots)];
}

/**
 * Tags to remove among `present` (the app's images on the server). Images
 * of other repositories are never touched; the live tag never.
 */
export function imagesToPrune(input: {
	folder: string;
	present: string[];
	releases: ReleaseRef[];
	liveSha: string | null;
	keep: number;
}): string[] {
	const kept = new Set(
		releasesToKeep(input.releases, input.liveSha, input.keep).map(
			(release) => release.imageTag,
		),
	);
	if (input.liveSha) kept.add(`${input.folder}:${input.liveSha}`);
	return [...new Set(input.present)]
		.filter((tag) => tag.startsWith(`${input.folder}:`))
		.filter((tag) => !kept.has(tag))
		.sort();
}

/** Releases of `pruned` tags (to mark them `pruned`). */
export function prunedReleaseIds(
	releases: ReleaseRef[],
	removed: string[],
): string[] {
	const set = new Set(removed);
	return releases
		.filter(
			(release) => release.status === "ready" && set.has(release.imageTag),
		)
		.map((release) => release.id);
}

export type RollbackRefusal = "not_found" | "live" | "not_ready";

/**
 * The release "Roll back to this" redeploys: it must be a ready release of
 * the app (image kept) other than the live one.
 */
export function pickRollback(
	releases: ReleaseRef[],
	releaseId: string,
	liveSha: string | null,
): { release: ReleaseRef } | { refusal: RollbackRefusal } {
	const release = releases.find((item) => item.id === releaseId);
	if (!release) return { refusal: "not_found" };
	if (release.commitSha === liveSha) return { refusal: "live" };
	if (release.status !== "ready") return { refusal: "not_ready" };
	return { release };
}
