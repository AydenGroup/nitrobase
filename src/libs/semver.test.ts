import { describe, expect, it } from "vitest";
import {
	compareSemVer,
	compareVersionNames,
	compareVersionOrder,
	isDowngrade,
	isPrerelease,
	parseVersion,
	updateKind,
} from "./semver";

const compare = (a: string, b: string) => {
	const left = parseVersion(a);
	const right = parseVersion(b);
	return left && right ? compareSemVer(left, right) : null;
};

describe("parseVersion", () => {
	it("reads prefixed and partial versions", () => {
		expect(parseVersion("v1.2.3")).toMatchObject({
			major: 1,
			minor: 2,
			patch: 3,
			prerelease: [],
			parts: 3,
		});
		expect(parseVersion("n8n@2.41.6")).toMatchObject({ major: 2, minor: 41 });
		expect(parseVersion("postgres@18.6")).toMatchObject({
			major: 18,
			minor: 6,
			patch: 0,
			parts: 2,
		});
		expect(parseVersion("v1.26.08")).toMatchObject({ minor: 26, patch: 8 });
	});

	it("tells pre-releases from variants", () => {
		expect(parseVersion("1.2.3-rc.1")?.prerelease).toEqual(["rc", "1"]);
		expect(parseVersion("0.1.0.beta")?.prerelease).toEqual(["beta"]);
		expect(parseVersion("8.4.11-alpine")?.prerelease).toEqual([]);
		expect(parseVersion("1.0.0+build.5")?.prerelease).toEqual([]);
		expect(isPrerelease("v2.0.0-beta.2")).toBe(true);
		// package.json and release tags (`v0.1.0-beta.0`).
		expect(parseVersion("0.1.0-beta.0")).toMatchObject({
			major: 0,
			minor: 1,
			patch: 0,
			prerelease: ["beta", "0"],
		});
		expect(isPrerelease("v0.1.0-beta.0")).toBe(true);
	});

	it("refuses non-versions", () => {
		expect(parseVersion("main")).toBeNull();
		expect(parseVersion("a1b2c3d")).toBeNull();
		expect(parseVersion("")).toBeNull();
	});
});

describe("compareSemVer", () => {
	it("orders numerically and puts releases after pre-releases", () => {
		expect(compare("v3.10.0", "v3.9.1")).toBeGreaterThan(0);
		expect(compare("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
		expect(compare("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
		expect(compare("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
		expect(compare("0.1.0-beta.0", "0.1.0-beta.1")).toBeLessThan(0);
		expect(compare("0.1.0-beta.9", "0.1.0-beta.10")).toBeLessThan(0);
		expect(compare("0.1.0-beta.1", "0.1.0")).toBeLessThan(0);
		expect(compare("1.2", "1.2.0")).toBe(0);
		expect(compare("main", "1.0.0")).toBeNull();
	});
});

describe("updateKind", () => {
	it("classifies the step", () => {
		expect(updateKind("1.2.3", "1.2.4")).toBe("patch");
		expect(updateKind("1.2.3", "1.3.0")).toBe("minor");
		expect(updateKind("1.2.3", "2.0.0")).toBe("major");
		expect(updateKind("1.2.3-rc.1", "1.2.3")).toBe("prerelease");
		expect(updateKind("v0.1.0.beta", "v0.1.0")).toBe("prerelease");
	});

	it("is null for downgrades, equal and unparseable versions", () => {
		expect(updateKind("1.2.4", "1.2.3")).toBeNull();
		expect(updateKind("1.2.3", "v1.2.3")).toBeNull();
		expect(updateKind("latest", "1.0.0")).toBeNull();
	});
});

describe("isDowngrade", () => {
	it("is true when the target is an older release", () => {
		expect(isDowngrade("2.4.5", "2.3.0")).toBe(true);
		expect(isDowngrade("v1.10.0", "v1.9.9")).toBe(true);
		expect(isDowngrade("n8n@2.0.0", "n8n@1.99.1")).toBe(true);
		expect(isDowngrade("2.0.0", "2.0.0-rc.1")).toBe(true);
	});

	it("is false for upgrades and the same version", () => {
		expect(isDowngrade("2.3.0", "2.4.5")).toBe(false);
		expect(isDowngrade("2.4.5", "2.4.5")).toBe(false);
		expect(isDowngrade("2.0.0-rc.1", "2.0.0")).toBe(false);
	});

	it("makes no claim for branches, commits or bare numbers", () => {
		expect(isDowngrade("main", "develop")).toBe(false);
		expect(isDowngrade("2.4.5", "main")).toBe(false);
		expect(isDowngrade("9f8e7d6c5b4a", "1a2b3c4d5e6f")).toBe(false);
		expect(isDowngrade("2.4.5", "1234567")).toBe(false);
		expect(isDowngrade("20", "19")).toBe(false);
	});

	it("orders 4-part versions and numbered pre-releases like version lists", () => {
		expect(isDowngrade("1.2.3.10", "1.2.3.9")).toBe(true);
		expect(isDowngrade("1.2.3.9", "1.2.3.10")).toBe(false);
		expect(compareVersionNames("1.2.3.10", "1.2.3.9")).toBeGreaterThan(0);
		expect(isDowngrade("2.0.0-rc10", "2.0.0-rc9")).toBe(true);
		expect(isDowngrade("2.0.0-rc9", "2.0.0-rc10")).toBe(false);
		// Only the spelling differs: not a downgrade.
		expect(isDowngrade("v2.4.5", "2.4.5")).toBe(false);
		expect(compareVersionOrder("v2.4.5", "2.4.5")).toBe(0);
	});
});

describe("numbered pre-releases", () => {
	it("compare their numbers, also without a dot", () => {
		expect(parseVersion("2.0.0-rc10")?.prerelease).toEqual(["rc", "10"]);
		expect(compare("2.0.0-rc9", "2.0.0-rc10")).toBeLessThan(0);
		expect(updateKind("2.0.0-rc9", "2.0.0-rc10")).toBe("prerelease");
		expect(updateKind("2.0.0-rc10", "2.0.0-rc9")).toBeNull();
	});
});
