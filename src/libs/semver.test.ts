import { describe, expect, it } from "vitest";
import {
	compareSemVer,
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
