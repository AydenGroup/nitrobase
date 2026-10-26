import { describe, expect, it, vi } from "vitest";
import { getCloudSyncProvider } from "#/config/cloud-sync.ts";

vi.mock("#/db/index.ts", () => ({ db: {} }));
vi.mock("#/features/apps/app-jobs.server.ts", () => ({}));
vi.mock("#/features/apps/apps.server.ts", () => ({}));
vi.mock("#/features/deployments/deployments.server.ts", () => ({}));
vi.mock("#/features/servers/servers.server.ts", () => ({}));
vi.mock("#/features/backups/rclone.server.ts", () => ({}));
vi.mock("#/server/services/audit.ts", () => ({}));
vi.mock("./connections.server", () => ({}));
vi.mock("./sync-job.server", () => ({}));

const { assertConfirmed, parseExportInputs } = await import("./export.server");

describe("export confirmation and inputs", () => {
	it("needs the cloud project's ID typed exactly", () => {
		expect(() =>
			assertConfirmed("abcdefghijklmnopqrst", " abcdefghijklmnopqrst "),
		).not.toThrow();
		for (const typed of ["", "abcdefghijklmnopqrs", "ABCDEFGHIJKLMNOPQRST"]) {
			let code: string | null = null;
			try {
				assertConfirmed("abcdefghijklmnopqrst", typed);
			} catch (error) {
				code = (error as { code?: string }).code ?? null;
			}
			expect(code, typed).toBe("CLOUD_EXPORT_CONFIRM_MISMATCH");
		}
	});

	it("validates the provider's export fields", () => {
		const supabase = getCloudSyncProvider("supabase");
		const appwrite = getCloudSyncProvider("appwrite");
		if (!supabase || !appwrite) throw new Error("providers");
		// `default`: the instance's CLOUD_SYNC_CRON_JOBS, resolved by the driver.
		expect(parseExportInputs(supabase, {})).toEqual({
			cronJobs: "default",
			stopWriters: false,
		});
		expect(
			parseExportInputs(supabase, { stopWriters: true, cronJobs: "skip" }),
		).toEqual({
			cronJobs: "skip",
			stopWriters: true,
		});
		expect(() =>
			parseExportInputs(supabase, { cronJobs: "sometimes" }),
		).toThrow();
		expect(
			parseExportInputs(appwrite, {
				localProjectId: "proj",
				localApiKey: "standard_x",
			}),
		).toEqual({ localProjectId: "proj", localApiKey: "standard_x" });
		expect(() =>
			parseExportInputs(appwrite, { localProjectId: "bad id!" }),
		).toThrow(expect.objectContaining({ code: "CLOUD_EXPORT_INPUT_INVALID" }));
	});
});
