import { describe, expect, it, vi } from "vitest";
import type { TemplateVersion } from "#/features/templates/schema.ts";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const {
	commitUrlTemplate,
	newerCommit,
	newerDatabaseVersion,
	newerTemplateVersion,
} = await import("./candidates");
const { autoUpdateAllowed, decideRollback, downgradeRisk, windowOpen } =
	await import("./policy");
const { databaseEngines } = await import("#/config/database-engines.ts");

const version = (ref: string, extra: Partial<TemplateVersion> = {}) => ({
	ref,
	name: ref,
	publishedAt: "2026-10-01T00:00:00Z",
	prerelease: false,
	url: `https://github.com/pocketbase/pocketbase/releases/tag/${ref}`,
	...extra,
});

describe("update policies", () => {
	it("applies only what the policy allows", () => {
		expect(autoUpdateAllowed("notify", "patch")).toBe(false);
		expect(autoUpdateAllowed("patch", "patch")).toBe(true);
		expect(autoUpdateAllowed("patch", "minor")).toBe(false);
		expect(autoUpdateAllowed("minor", "minor")).toBe(true);
		expect(autoUpdateAllowed("minor", "patch")).toBe(true);
		for (const kind of ["major", "prerelease", "commit", "unknown"] as const) {
			expect(autoUpdateAllowed("minor", kind)).toBe(false);
		}
		expect(autoUpdateAllowed("minor", null)).toBe(false);
	});

	it("opens the maintenance window from its start for its length", () => {
		const start = new Date("2026-10-06T03:00:00Z");
		expect(windowOpen(start, new Date("2026-10-06T03:00:00Z"), 120)).toBe(true);
		expect(windowOpen(start, new Date("2026-10-06T04:59:59Z"), 120)).toBe(true);
		expect(windowOpen(start, new Date("2026-10-06T05:00:00Z"), 120)).toBe(
			false,
		);
		expect(windowOpen(start, new Date("2026-10-06T02:59:00Z"), 120)).toBe(
			false,
		);
	});
});

describe("rollback decision", () => {
	it("does nothing when the running version was never replaced", () => {
		expect(
			decideRollback({ mode: "restore", appTouched: false, backupTaken: true }),
		).toEqual({ action: "none" });
	});

	it("follows the source's rollback mode", () => {
		expect(
			decideRollback({
				mode: "redeploy",
				appTouched: true,
				backupTaken: false,
			}),
		).toEqual({ action: "redeploy" });
		expect(
			decideRollback({ mode: "restore", appTouched: true, backupTaken: true }),
		).toEqual({ action: "restore" });
		expect(
			decideRollback({ mode: "manual", appTouched: true, backupTaken: true }),
		).toEqual({ action: "manual", reason: "mode" });
	});

	it("never redeploys an old version onto possibly migrated data", () => {
		expect(
			decideRollback({ mode: "restore", appTouched: true, backupTaken: false }),
		).toEqual({ action: "manual", reason: "no_backup" });
	});
});

describe("update candidates", () => {
	it("offers the newest template release when newer", () => {
		const versions = [
			version("v0.31.0"),
			version("v0.30.4"),
			version("v0.30.0"),
		];
		expect(
			newerTemplateVersion({
				versions,
				current: "v0.30.0",
				currentCommit: "abc",
				commits: false,
			}),
		).toMatchObject({
			version: "v0.31.0",
			kind: "minor",
			url: "https://github.com/pocketbase/pocketbase/releases/tag/v0.31.0",
		});
		expect(
			newerTemplateVersion({
				versions,
				current: "v0.31.0",
				currentCommit: null,
				commits: false,
			}),
		).toBeNull();
		// The list's newest is older than what runs (yanked release).
		expect(
			newerTemplateVersion({
				versions: [version("v0.30.4")],
				current: "v0.31.0",
				currentCommit: null,
				commits: false,
			}),
		).toBeNull();
	});

	it("handles prefixed and non-semver names", () => {
		expect(
			newerTemplateVersion({
				versions: [version("n8n@2.42.1")],
				current: "n8n@2.41.6",
				currentCommit: null,
				commits: false,
			})?.kind,
		).toBe("minor");
		expect(
			newerTemplateVersion({
				versions: [version("2026.10.2-r7")],
				current: "2026.10.1-r3",
				currentCommit: null,
				commits: false,
			})?.kind,
		).toBe("patch");
		expect(
			newerTemplateVersion({
				versions: [version("build_12")],
				current: "build_9",
				currentCommit: null,
				commits: false,
			})?.kind,
		).toBe("unknown");
	});

	it("compares commits for commit-based sources", () => {
		const sha = (char: string) => char.repeat(40);
		const versions = [version(sha("b")), version(sha("a"))];
		expect(
			newerTemplateVersion({
				versions,
				current: sha("a"),
				currentCommit: sha("a"),
				commits: true,
			})?.kind,
		).toBe("commit");
		expect(
			newerTemplateVersion({
				versions,
				current: "main",
				currentCommit: sha("b"),
				commits: true,
			}),
		).toBeNull();
	});

	it("offers the newest in-place database version", () => {
		const postgres = databaseEngines.postgres.versions;
		const newest18 = postgres.find((item) => item.major === "18")?.tag ?? "";
		const candidate = newerDatabaseVersion("postgres", "18.0");
		expect(candidate?.version).toBe(`postgres@${newest18}`);
		expect(candidate?.kind).toBe("minor");
		// Never across a major line for patch-only engines.
		expect(newerDatabaseVersion("postgres", newest18)).toBeNull();
		const valkey = databaseEngines.valkey.versions[0].tag;
		expect(newerDatabaseVersion("valkey", "8.1.0")?.version).toBe(
			`valkey@${valkey}`,
		);
	});

	it("offers the branch tip of a Git app", () => {
		const tip = "c".repeat(40);
		expect(
			newerCommit({
				tip,
				deployed: "d".repeat(40),
				branch: "main",
				commitUrl: "https://github.com/acme/app/commit/{sha}",
			}),
		).toEqual({
			version: tip,
			name: `main@${"c".repeat(12)}`,
			url: `https://github.com/acme/app/commit/${tip}`,
			publishedAt: null,
			kind: "commit",
		});
		expect(
			newerCommit({ tip, deployed: tip, branch: "main", commitUrl: null }),
		).toBeNull();
		expect(
			newerCommit({
				tip: "nope",
				deployed: null,
				branch: "main",
				commitUrl: null,
			}),
		).toBeNull();
	});

	it("links commits only for https repositories without credentials", () => {
		expect(commitUrlTemplate("https://github.com/acme/app.git")).toBe(
			"https://github.com/acme/app/commit/{sha}",
		);
		expect(commitUrlTemplate("https://gitlab.com/acme/app")).toBe(
			"https://gitlab.com/acme/app/-/commit/{sha}",
		);
		expect(commitUrlTemplate("git@github.com:acme/app.git")).toBeNull();
		expect(commitUrlTemplate("https://user:pw@git.example.com/a/b")).toBeNull();
		expect(commitUrlTemplate("http://git.example.com/a/b")).toBeNull();
	});
});

const { isTemplateTarget } = await import("./candidates");

describe("template update targets", () => {
	const versions = [version("v0.31.0"), version("v0.30.4"), version("v0.30.0")];
	const check = (target: string, current = "v0.30.4") =>
		isTemplateTarget({
			versions,
			current,
			currentCommit: null,
			commits: false,
			target,
		});

	it("accepts listed, newer versions only", () => {
		expect(check("v0.31.0")).toBe(true);
		expect(check("v0.30.0")).toBe(false); // downgrade
		expect(check("v0.30.4")).toBe(false); // what runs
		expect(check("v9.9.9")).toBe(false); // not listed
		expect(check("main")).toBe(false);
	});
});

describe("downgrade risk", () => {
	const risk = (
		from: string,
		to: string,
		extra: Partial<Parameters<typeof downgradeRisk>[0]> = {},
	) =>
		downgradeRisk({ from, to, ordered: true, rollback: "redeploy", ...extra });

	it("flags an older target, stronger with irreversible migrations", () => {
		expect(risk("2.4.5", "2.3.0")).toBe("downgrade");
		expect(risk("2.4.5", "2.3.0", { rollback: "restore" })).toBe(
			"irreversible",
		);
	});

	it("says nothing for upgrades or versions that do not compare", () => {
		expect(risk("2.3.0", "2.4.5", { rollback: "restore" })).toBeNull();
		expect(risk("2.4.5", "2.3.0", { ordered: false })).toBeNull();
		expect(risk("main", "develop")).toBeNull();
		expect(
			risk("2.4.5", "0123456789abcdef0123456789abcdef01234567"),
		).toBeNull();
	});
});
