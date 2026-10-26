import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { AppwritePluginConfigSchema } from "#/features/appwrite/schema.ts";
import { SupabasePluginConfigSchema } from "#/features/supabase/schema.ts";
import { cloudSyncDrivers } from "#/server/services/cloud-sync/drivers.ts";
import { auditActions } from "./audit-actions";
import {
	cloudSyncProviders,
	connectionInfoLabel,
	connectionTestStepLabel,
	getCloudSyncProvider,
	partsFor,
	providerSecretFields,
	providersForTemplate,
	SYNC_PART_PATTERN,
	syncPartLabel,
	syncPartLabels,
} from "./cloud-sync";
import { jobTypes } from "./status";

describe("cloud sync provider registry", () => {
	it("has unique ids, a driver, a template, a job type and an audit action each", () => {
		const ids = cloudSyncProviders.map((provider) => provider.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const provider of cloudSyncProviders) {
			expect(cloudSyncDrivers[provider.id], provider.id).toBeDefined();
			expect(existsSync(`templates/${provider.templateId}/template.toml`)).toBe(
				true,
			);
			expect(Object.keys(jobTypes)).toContain(provider.importJobType);
			expect(Object.keys(auditActions)).toContain(provider.importAuditAction);
			expect(Object.keys(jobTypes)).toContain(provider.exportJobType);
			expect(Object.keys(auditActions)).toContain(provider.exportAuditAction);
			// Export fields are asked per job: nothing in them is stored.
			expect(provider.exportSchema.safeParse({}).success, provider.id).toBe(
				true,
			);
			expect(Object.keys(provider.schema.shape)).toContain(
				provider.projectField,
			);
		}
	});

	it("only allows narrow host patterns", () => {
		for (const provider of cloudSyncProviders) {
			expect(provider.allowedHosts.length).toBeGreaterThan(0);
			for (const host of provider.allowedHosts) {
				// A wildcard needs at least a registrable domain after it.
				expect(host).toMatch(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/);
			}
		}
	});

	it("keeps credentials in secret fields", () => {
		const supabase = getCloudSyncProvider("supabase");
		expect(supabase && providerSecretFields(supabase).sort()).toEqual([
			"accessToken",
			"dbPassword",
			"s3SecretAccessKey",
		]);
	});

	it("lists import parts and finds providers by template", () => {
		const supabase = getCloudSyncProvider("supabase");
		expect(supabase && partsFor(supabase, "import")).toEqual([
			"database",
			"storage",
			"functions",
		]);
		expect(supabase && partsFor(supabase, "export")).toEqual([
			"database",
			"storage",
			"functions",
		]);
		expect(providersForTemplate("supabase").map((p) => p.id)).toEqual([
			"supabase",
		]);
		expect(getCloudSyncProvider("nope")).toBeNull();
	});

	it("validates a Supabase connection", () => {
		const schema = getCloudSyncProvider("supabase")?.schema;
		const valid = {
			projectRef: "abcdefghijklmnopqrst",
			accessToken: "sbp_0123456789",
			dbPassword: "pw",
		};
		expect(schema?.safeParse(valid).success).toBe(true);
		expect(schema?.safeParse({ ...valid, projectRef: "ABC" }).success).toBe(
			false,
		);
		expect(
			schema?.safeParse({ ...valid, poolerHost: "bad host" }).success,
		).toBe(false);
		expect(schema?.safeParse({ ...valid, accessToken: "a\nb" }).success).toBe(
			false,
		);
	});

	it("keeps the Supabase parts, steps and labels stored rows use", () => {
		const supabase = getCloudSyncProvider("supabase");
		expect(
			supabase?.parts.map((part) => [part.id, part.label.id, part.directions]),
		).toEqual([
			["database", "Database", ["import", "export"]],
			["storage", "Storage files", ["import", "export"]],
			["functions", "Edge functions", ["import", "export"]],
		]);
		expect(supabase?.testSteps.map((step) => [step.id, step.label.id])).toEqual(
			[
				["api", "Management API"],
				["database", "Database (pooler)"],
				["storage", "Storage (S3)"],
			],
		);
		expect(Object.keys(supabase?.infoLabels ?? {})).toEqual([
			"project",
			"region",
			"status",
			"postgres",
			"pooler",
			"server",
			"buckets",
		]);
		expect(supabase?.versionLabel.id).toBe("Postgres");
		// History rows of either provider render their part labels.
		expect(syncPartLabel(supabase ?? null, "functions")?.id).toBe(
			"Edge functions",
		);
		expect(syncPartLabel(null, "database")?.id).toBe("Database");
		expect(connectionTestStepLabel(supabase ?? null, "database")?.id).toBe(
			"Database (pooler)",
		);
		expect(connectionInfoLabel(supabase ?? null, "postgres")?.id).toBe(
			"Postgres version",
		);
		expect(connectionInfoLabel(supabase ?? null, "toString")).toBeUndefined();
	});

	it("declares parts and steps with unique ids, and shared part ids mean the same", () => {
		const labels = new Map<string, string>();
		for (const provider of cloudSyncProviders) {
			const parts = provider.parts.map((part) => part.id);
			expect(new Set(parts).size, provider.id).toBe(parts.length);
			const steps = provider.testSteps.map((step) => step.id);
			expect(new Set(steps).size, provider.id).toBe(steps.length);
			for (const part of provider.parts) {
				expect(part.id).toMatch(SYNC_PART_PATTERN);
				const seen = labels.get(part.id);
				if (seen) expect(part.label.id, part.id).toBe(seen);
				labels.set(part.id, part.label.id);
				expect(syncPartLabels[part.id]?.id).toBe(part.label.id);
			}
		}
	});

	it("maps every Appwrite part to migration resources in the template", () => {
		const appwrite = getCloudSyncProvider("appwrite");
		expect(appwrite?.templateId).toBe("appwrite");
		const manifest = parseToml(
			readFileSync("templates/appwrite/template.toml", "utf8"),
		) as { plugin?: unknown };
		const plugin = AppwritePluginConfigSchema.parse(manifest.plugin);
		for (const part of partsFor(appwrite ?? cloudSyncProviders[0], "import")) {
			expect(plugin.sync_resources[part]?.length, part).toBeGreaterThan(0);
		}
		expect(Object.values(plugin.sync_resources).flat()).toEqual(
			expect.arrayContaining([
				"user",
				"team",
				"membership",
				"database",
				"table",
				"column",
				"index",
				"row",
				"bucket",
				"file",
				"function",
				"environment-variable",
				"platform",
			]),
		);
	});

	it("declares what an export needs in the templates", () => {
		const read = (id: string) =>
			(
				parseToml(readFileSync(`templates/${id}/template.toml`, "utf8")) as {
					plugin?: unknown;
				}
			).plugin;
		const appwrite = AppwritePluginConfigSchema.parse(read("appwrite"));
		expect(appwrite.sync_export_key_scopes.length).toBeGreaterThan(0);
		// The cloud reads the app: never a write scope on the app's key.
		expect(
			appwrite.sync_export_key_scopes.filter(
				(scope) => !scope.endsWith(".read"),
			),
		).toEqual([]);
		expect(appwrite.sync_cloud_key_scopes).toContain("migrations.write");
		const supabase = SupabasePluginConfigSchema.parse(read("supabase"));
		expect(supabase.functions_entrypoints).toContain("index.ts");
		// The copy reads through storage and functions: they keep running.
		expect(supabase.sync_export_writer_services).not.toContain("storage");
		expect(supabase.sync_export_writer_services).not.toContain(
			supabase.functions_service,
		);
	});

	it("validates an Appwrite connection", () => {
		const appwrite = getCloudSyncProvider("appwrite");
		const schema = appwrite?.schema;
		expect(appwrite && providerSecretFields(appwrite)).toEqual(["apiKey"]);
		const valid = {
			endpoint: "https://fra.cloud.appwrite.io/v1/",
			projectId: "65f0c0ffee0123456789",
			apiKey: "standard_abc",
		};
		expect(schema?.parse(valid)).toMatchObject({
			endpoint: "https://fra.cloud.appwrite.io/v1",
		});
		for (const endpoint of [
			"http://fra.cloud.appwrite.io/v1",
			"https://fra.cloud.appwrite.io/v2",
			"https://user:pw@fra.cloud.appwrite.io/v1",
			"https://fra.cloud.appwrite.io/v1?x=1",
			"not a url",
		]) {
			expect(schema?.safeParse({ ...valid, endpoint }).success, endpoint).toBe(
				false,
			);
		}
		expect(schema?.safeParse({ ...valid, projectId: "bad id!" }).success).toBe(
			false,
		);
		expect(appwrite?.allowedHosts).toEqual([
			"cloud.appwrite.io",
			"*.cloud.appwrite.io",
		]);
	});
});
