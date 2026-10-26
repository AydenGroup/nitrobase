import { describe, expect, it, vi } from "vitest";
import { getCloudSyncProvider, importFields } from "#/config/cloud-sync.ts";

vi.mock("#/db/index.ts", () => ({ db: {} }));
vi.mock("#/features/apps/app-jobs.server.ts", () => ({}));
vi.mock("#/features/apps/apps.server.ts", () => ({}));
vi.mock("#/features/deployments/deployments.server.ts", () => ({}));
vi.mock("#/features/servers/servers.server.ts", () => ({}));
vi.mock("#/features/backups/rclone.server.ts", () => ({}));
vi.mock("#/features/backups/destinations.server.ts", () => ({}));
vi.mock("#/features/templates/templates.server.ts", () => ({}));
vi.mock("#/server/services/audit.ts", () => ({}));
vi.mock("./connections.server", () => ({}));
vi.mock("./sync-job.server", () => ({}));

const { parseImportInputs } = await import("./import.server");
const { CloudImportSchema, CloudPreflightSchema } = await import("./schema");

describe("import inputs", () => {
	const supabase = getCloudSyncProvider("supabase");
	const appwrite = getCloudSyncProvider("appwrite");
	if (!supabase || !appwrite) throw new Error("providers");

	it("offers the cron choice per run, the instance default first", () => {
		const [field] = importFields(supabase);
		expect(field).toMatchObject({
			name: "cronJobs",
			kind: "enum",
			defaultValue: "default",
		});
		expect(field?.meta.options?.map((option) => option.value)).toEqual([
			"default",
			"paused",
			"active",
			"skip",
		]);
		expect(importFields(appwrite)).toEqual([]);
	});

	it("validates the provider's import fields", () => {
		expect(parseImportInputs(supabase, {})).toEqual({ cronJobs: "default" });
		expect(parseImportInputs(supabase, { cronJobs: "active" })).toEqual({
			cronJobs: "active",
		});
		expect(() => parseImportInputs(supabase, { cronJobs: "often" })).toThrow(
			expect.objectContaining({ code: "CLOUD_IMPORT_INPUT_INVALID" }),
		);
		expect(parseImportInputs(appwrite, { cronJobs: "skip" })).toEqual({});
	});

	it("carries the inputs through the preview and start payloads", () => {
		const base = {
			connectionId: "00000000-0000-4000-8000-000000000001",
			serverId: "00000000-0000-4000-8000-000000000002",
			parts: ["database"],
		};
		expect(CloudPreflightSchema.parse(base).inputs).toEqual({});
		expect(
			CloudImportSchema.parse({
				...base,
				name: "app",
				inputs: { cronJobs: "skip" },
			}).inputs,
		).toEqual({ cronJobs: "skip" });
	});
});
