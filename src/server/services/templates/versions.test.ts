import { describe, expect, it } from "vitest";
import {
	belowMinVersion,
	defaultVersion,
	filterVersions,
	isVersionOffered,
	versionOffer,
	versionsFromCommits,
	versionsFromReleases,
	versionsFromTags,
} from "./versions";

const releases = versionsFromReleases([
	{
		tag_name: "v2.0.0-rc.1",
		name: null,
		published_at: "2026-03-01",
		prerelease: true,
		draft: false,
	},
	{
		tag_name: "v1.9.0",
		name: "1.9",
		published_at: "2026-02-01",
		prerelease: false,
		draft: false,
	},
	{
		tag_name: "v1.10.0",
		name: null,
		published_at: null,
		prerelease: false,
		draft: true,
	},
	{
		tag_name: "v0.22.1",
		name: null,
		published_at: "2026-01-01",
		prerelease: false,
		draft: false,
	},
]);

describe("versions", () => {
	it("maps releases, hides drafts, keeps order", () => {
		expect(releases.map((v) => v.ref)).toEqual([
			"v2.0.0-rc.1",
			"v1.9.0",
			"v0.22.1",
		]);
		expect(releases[0].prerelease).toBe(true);
		expect(releases[1].name).toBe("1.9");
	});

	it("defaults to the newest stable version matching the filter", () => {
		expect(defaultVersion(releases)?.ref).toBe("v1.9.0");
		expect(defaultVersion(releases, { filter: "^v0\\." })?.ref).toBe("v0.22.1");
		expect(defaultVersion([], {})).toBeNull();
	});

	it("never offers versions below the template's min_version", () => {
		const offer = { minVersion: "v1.9.0" };
		expect(
			filterVersions(releases, { ...offer, includePrereleases: true }).map(
				(v) => v.ref,
			),
		).toEqual(["v2.0.0-rc.1", "v1.9.0"]);
		expect(defaultVersion(releases, offer)?.ref).toBe("v1.9.0");
		expect(defaultVersion(releases, { minVersion: "v1.10.0" })).toBeNull();
		expect(isVersionOffered("v0.22.1", offer)).toBe(false);
		expect(isVersionOffered("v1.26.07", { minVersion: "v1.26.07" })).toBe(true);
		expect(isVersionOffered("v1.26.05", { minVersion: "v1.26.07" })).toBe(
			false,
		);
		expect(
			isVersionOffered("v1.26.10", {
				filter: "^v[0-9]+\\.[0-9]+\\.[0-9]+$",
				minVersion: "v1.26.07",
			}),
		).toBe(true);
		expect(
			versionOffer({ version_filter: "^v", min_version: "v1.0.0" }),
		).toEqual({ filter: "^v", minVersion: "v1.0.0" });
	});

	it("names the floor a version is below", () => {
		const source = { versions: "releases", min_version: "v1.26.07" };
		expect(belowMinVersion(source, "v1.26.05")).toBe("v1.26.07");
		expect(belowMinVersion(source, "v1.26.07")).toBeNull();
		expect(belowMinVersion(source, null)).toBeNull();
		expect(belowMinVersion({ versions: "releases" }, "v0.1.0")).toBeNull();
		expect(
			belowMinVersion({ ...source, versions: "commits" }, "abc"),
		).toBeNull();
	});

	it("shows prereleases only behind the toggle", () => {
		expect(filterVersions(releases, {}).map((v) => v.ref)).toEqual([
			"v1.9.0",
			"v0.22.1",
		]);
		expect(filterVersions(releases, { includePrereleases: true })).toHaveLength(
			3,
		);
	});

	it("flags prerelease-looking tags and maps commits", () => {
		expect(
			versionsFromTags([{ name: "v3.0.0-beta", commit: { sha: "a" } }])[0]
				.prerelease,
		).toBe(true);
		const [commit] = versionsFromCommits([
			{
				sha: "abcdef1234567890",
				commit: {
					message: "fix: x\n\nbody",
					committer: { date: "2026-01-01" },
				},
			},
		]);
		expect(commit).toEqual({
			ref: "abcdef1234567890",
			name: "abcdef1 fix: x",
			publishedAt: "2026-01-01",
			prerelease: false,
		});
	});
});

describe("branches and version numbers", () => {
	it("orders version branches newest first", async () => {
		const { versionsFromBranches, versionNumber } = await import("./versions");
		const versions = versionsFromBranches(
			["v2.1.5", "v3.10.0", "fix-low-resources", "v3.9.1", "v3.2.1"].map(
				(name) => ({ name, commit: { sha: "x" } }),
			),
		);
		expect(versions.map((v) => v.ref)).toEqual([
			"v3.10.0",
			"v3.9.1",
			"v3.2.1",
			"v2.1.5",
			"fix-low-resources",
		]);
		expect(versionNumber("n8n@2.41.6", "n8n@")).toBe("2.41.6");
		expect(versionNumber("v1.2.3")).toBe("1.2.3");
		expect(versionNumber("vnext")).toBe("vnext");
		expect(versionNumber("2.3.0")).toBe("2.3.0");
	});
});

describe("compareVersionNames / versionAtLeast", () => {
	it("ranks a pre-release below its release", async () => {
		const { compareVersionNames } = await import("./versions");
		const sorted = [
			"v1.26.04",
			"v1.26.04-rc1",
			"v1.26.03",
			"v1.26.04-rc2",
			"v1.26.10",
			"v1.26.04-beta.3",
		].sort(compareVersionNames);
		expect(sorted).toEqual([
			"v1.26.03",
			"v1.26.04-beta.3",
			"v1.26.04-rc1",
			"v1.26.04-rc2",
			"v1.26.04",
			"v1.26.10",
		]);
		expect(compareVersionNames("v2.0.0-rc.1", "v1.9.9")).toBeGreaterThan(0);
		expect(compareVersionNames("n8n@1.2.3", "n8n@1.10.0")).toBeLessThan(0);
		// Date-like names are not pre-releases.
		expect(compareVersionNames("2024-01-02", "2024-01-01")).toBeGreaterThan(0);
	});

	it("gates on the release, not its pre-releases", async () => {
		const { versionAtLeast } = await import("./render");
		expect(versionAtLeast("v1.26.04", "v1.26.04")).toBe(true);
		expect(versionAtLeast("v1.26.08", "v1.26.04")).toBe(true);
		expect(versionAtLeast("v1.26.04-rc1", "v1.26.04")).toBe(false);
		expect(versionAtLeast("v1.26.03", "v1.26.04")).toBe(false);
		expect(versionAtLeast("anything", undefined)).toBe(true);
	});
});
