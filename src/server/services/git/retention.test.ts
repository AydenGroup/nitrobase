import { describe, expect, it } from "vitest";
import {
	imagesToPrune,
	pickRollback,
	prunedReleaseIds,
	type ReleaseRef,
	releasesToKeep,
} from "./retention";

const folder = "git-1234abcd";
const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 12, minutes));

function release(
	n: number,
	status: ReleaseRef["status"],
	created: number,
	deployed: number | null = null,
): ReleaseRef {
	return {
		id: `r${n}`,
		commitSha: sha(n),
		imageTag: `${folder}:${sha(n)}`,
		status,
		createdAt: at(created),
		lastDeployedAt: deployed === null ? null : at(deployed),
	};
}

describe("image retention", () => {
	const releases = [
		release(1, "ready", 1, 2),
		release(2, "ready", 3, 4),
		release(3, "failed", 5),
		release(4, "ready", 6, 7),
		release(5, "ready", 8, 9),
	];

	it("keeps the live image plus the most recently used others", () => {
		expect(releasesToKeep(releases, sha(1), 2).map((item) => item.id)).toEqual([
			"r1",
			"r5",
		]);
	});

	it("prunes beyond N, never the live tag nor other repositories", () => {
		const present = [
			...releases.map((item) => item.imageTag),
			`${folder}:${sha(9)}-raw`,
			"git-ffffffff:other",
			"nginx:alpine",
		];
		expect(
			imagesToPrune({ folder, present, releases, liveSha: sha(1), keep: 2 }),
		).toEqual(
			[
				`${folder}:${sha(2)}`,
				`${folder}:${sha(3)}`,
				`${folder}:${sha(4)}`,
				`${folder}:${sha(9)}-raw`,
			].sort(),
		);
	});

	it("keeps the live tag even when its release row is missing", () => {
		const live = `${folder}:${sha(7)}`;
		expect(
			imagesToPrune({
				folder,
				present: [live],
				releases: [],
				liveSha: sha(7),
				keep: 1,
			}),
		).toEqual([]);
	});

	it("maps removed tags back to releases", () => {
		expect(prunedReleaseIds(releases, [`${folder}:${sha(2)}`])).toEqual(["r2"]);
	});
});

describe("rollback", () => {
	const releases = [
		release(1, "ready", 1, 2),
		release(2, "pruned", 3, 4),
		release(3, "ready", 5, 6),
	];
	it("picks a kept, non-live release", () => {
		expect(pickRollback(releases, "r1", sha(3))).toEqual({
			release: releases[0],
		});
	});
	it("refuses the live, pruned or unknown ones", () => {
		expect(pickRollback(releases, "r3", sha(3))).toEqual({ refusal: "live" });
		expect(pickRollback(releases, "r2", sha(3))).toEqual({
			refusal: "not_ready",
		});
		expect(pickRollback(releases, "nope", sha(3))).toEqual({
			refusal: "not_found",
		});
	});
});
