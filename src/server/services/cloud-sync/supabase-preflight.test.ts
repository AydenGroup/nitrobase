import { describe, expect, it } from "vitest";
import {
	analyzePreflight,
	imageMajor,
	type PreflightFacts,
} from "./supabase-preflight";

const base: PreflightFacts = {
	parts: ["database", "storage", "functions"],
	sourceMajor: 17,
	targetMajor: 17,
	databaseBytes: 1000,
	storageBytes: 3000,
	freeDiskBytes: 1_000_000,
	diskFactor: 2.5,
	vaultSecrets: 0,
	rootKeyAvailable: false,
	extensions: ["plpgsql", "pgcrypto"],
	cloudReferences: [],
	customRoles: [],
	functionsWithoutJwt: [],
	functionCount: 0,
	tlsVerified: true,
	hasStorageKeys: true,
	cronJobs: 0,
	cronMode: "paused",
};

const codes = (items: { code: string | null }[]) => items.map((i) => i.code);

describe("preflight analysis", () => {
	it("says what happens to the cloud's cron jobs", () => {
		const result = analyzePreflight({ ...base, cronJobs: 2 });
		expect(result.warnings).toContainEqual({
			code: "CLOUD_WARN_CRON_JOBS",
			params: { count: 2, mode: "paused" },
			text: null,
		});
		expect(
			codes(
				analyzePreflight({ ...base, cronJobs: 2, parts: ["storage"] }).warnings,
			),
		).not.toContain("CLOUD_WARN_CRON_JOBS");
	});

	it("passes a same-version import with room to spare", () => {
		const result = analyzePreflight(base);
		expect(result.blockers).toEqual([]);
		expect(result.requiredDiskBytes).toBe(10_000);
		expect(codes(result.warnings)).toEqual([
			"CLOUD_WARN_KEYS_CHANGE",
			"CLOUD_WARN_SESSIONS",
			"CLOUD_WARN_NOT_SYNCED",
		]);
	});

	it("refuses newer to older Postgres majors, and unknown sources", () => {
		const downgrade = analyzePreflight({
			...base,
			sourceMajor: 17,
			targetMajor: 15,
		});
		expect(downgrade.blockers).toEqual([
			{
				code: "CLOUD_SYNC_VERSION_DOWNGRADE",
				params: { source: 17, target: 15 },
				text: null,
			},
		]);
		expect(
			analyzePreflight({ ...base, sourceMajor: 15, targetMajor: 17 }).blockers,
		).toEqual([]);
		expect(
			codes(analyzePreflight({ ...base, sourceMajor: null }).blockers),
		).toEqual(["CLOUD_SYNC_VERSION_UNKNOWN"]);
		// Unknown target: the job checks again once the app runs.
		expect(analyzePreflight({ ...base, targetMajor: null }).blockers).toEqual(
			[],
		);
	});

	it("needs disk for the parts copied only", () => {
		const low = analyzePreflight({ ...base, freeDiskBytes: 5000 });
		expect(codes(low.blockers)).toEqual(["CLOUD_SYNC_DISK_LOW"]);
		const dbOnly = analyzePreflight({
			...base,
			parts: ["database"],
			freeDiskBytes: 5000,
		});
		expect(dbOnly.blockers).toEqual([]);
		expect(dbOnly.requiredDiskBytes).toBe(2500);
		expect(codes(analyzePreflight({ ...base, parts: [] }).blockers)).toContain(
			"CLOUD_SYNC_PARTS_EMPTY",
		);
	});

	it("counts vault secrets, readable only with the copied key", () => {
		const lost = analyzePreflight({ ...base, vaultSecrets: 3 });
		expect(lost.warnings).toContainEqual({
			code: "CLOUD_WARN_VAULT_UNREADABLE",
			params: { count: 3 },
			text: null,
		});
		const kept = analyzePreflight({
			...base,
			vaultSecrets: 3,
			rootKeyAvailable: true,
		});
		expect(codes(kept.warnings)).toContain("CLOUD_WARN_VAULT_KEY_COPIED");
	});

	it("lists extensions, roles, cloud references and function caveats", () => {
		const result = analyzePreflight({
			...base,
			extensions: ["plpgsql", "postgis", "pg_cron"],
			customRoles: ["reporting"],
			cloudReferences: ["cron: ping"],
			functionCount: 2,
			functionsWithoutJwt: ["webhook"],
			tlsVerified: false,
			hasStorageKeys: false,
		});
		expect(result.warnings).toContainEqual({
			code: "CLOUD_WARN_EXTENSIONS",
			params: { names: { $list: ["pg_cron", "postgis"] } },
			text: null,
		});
		expect(codes(result.warnings)).toEqual(
			expect.arrayContaining([
				"CLOUD_WARN_ROLE_PASSWORDS",
				"CLOUD_WARN_CLOUD_REFERENCES",
				"CLOUD_WARN_FUNCTION_SECRETS",
				"CLOUD_WARN_FUNCTIONS_VERIFY_JWT",
				"CLOUD_WARN_TLS_UNVERIFIED",
				"CLOUD_WARN_STORAGE_NO_KEYS",
			]),
		);
	});

	it("reads the Postgres major of an image tag", () => {
		expect(imageMajor("supabase/postgres:17.6.1.136")).toBe(17);
		expect(imageMajor("supabase/postgres:15.8.1.085")).toBe(15);
		expect(imageMajor("postgres:16-alpine")).toBe(16);
		expect(imageMajor("postgres:latest")).toBeNull();
		expect(imageMajor(undefined)).toBeNull();
	});
});
