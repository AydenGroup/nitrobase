import { describe, expect, it } from "vitest";
import { hostMatches, PinnedHttpError, resolvePinned } from "./pinned-http";

describe("host allowlist", () => {
	const patterns = [
		"api.supabase.com",
		"*.supabase.co",
		"*.pooler.supabase.com",
	];
	it("matches exact names and subdomains of wildcards", () => {
		expect(hostMatches("api.supabase.com", patterns)).toBe(true);
		expect(hostMatches("API.Supabase.com.", patterns)).toBe(true);
		expect(hostMatches("abc.storage.supabase.co", patterns)).toBe(true);
		expect(
			hostMatches("aws-1-eu-central-1.pooler.supabase.com", patterns),
		).toBe(true);
	});

	it("rejects bare suffixes, look-alikes and other hosts", () => {
		expect(hostMatches("supabase.co", patterns)).toBe(false);
		expect(hostMatches("evilsupabase.co", patterns)).toBe(false);
		expect(hostMatches("supabase.co.evil.com", patterns)).toBe(false);
		expect(hostMatches("db.supabase.com", patterns)).toBe(false);
		expect(hostMatches("169.254.169.254", patterns)).toBe(false);
	});
});

describe("address pinning", () => {
	const resolveTo = (address: string) => async () => [{ address, family: 4 }];

	it("refuses names resolving to private addresses", async () => {
		await expect(
			resolvePinned("api.example.com", false, resolveTo("10.0.0.5")),
		).rejects.toMatchObject({ kind: "blocked" });
		await expect(resolvePinned("127.0.0.1", false)).rejects.toBeInstanceOf(
			PinnedHttpError,
		);
	});

	it("returns the checked public address (or a private one when allowed)", async () => {
		await expect(
			resolvePinned("api.example.com", false, resolveTo("3.65.1.2")),
		).resolves.toEqual({ address: "3.65.1.2", family: 4 });
		await expect(
			resolvePinned("db.local", true, resolveTo("10.0.0.5")),
		).resolves.toEqual({ address: "10.0.0.5", family: 4 });
	});

	it("reports names that do not resolve", async () => {
		await expect(
			resolvePinned("nowhere.example", false, async () => {
				throw new PinnedHttpError("network", "no", true);
			}),
		).rejects.toMatchObject({ kind: "network" });
	});
});
