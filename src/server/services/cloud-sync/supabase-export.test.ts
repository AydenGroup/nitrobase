import { describe, expect, it } from "vitest";
import { SupabasePluginConfigSchema } from "#/features/supabase/schema.ts";
import {
	bucketCopyArgs,
	pgClientCommand,
	prepareSyncWorkDirCommand,
} from "./commands";
import { buildMultipart, parseMultipart } from "./multipart";
import { deployParts, FUNCTION_UPLOAD_ROOT } from "./supabase-api";
import { dumpArgs, EXPORT_EXCLUDED_TABLES } from "./supabase-dump";
import {
	exportCapability,
	functionDeploy,
	isStagingSchema,
	sharedImports,
	stagingSchemaName,
} from "./supabase-export";
import {
	analyzeExportPreflight,
	type CloudContents,
	cloudContentItems,
	type ExportFacts,
} from "./supabase-preflight";

const empty: CloudContents = {
	relations: [],
	functions: [],
	users: 0,
	buckets: 0,
	objects: 0,
	vaultSecrets: 0,
	edgeFunctions: [],
};

const facts = (patch: Partial<ExportFacts> = {}): ExportFacts => ({
	parts: ["database", "storage", "functions"],
	localMajor: 15,
	cloudMajor: 17,
	cloud: empty,
	canWrite: true,
	databaseBytes: 1000,
	freeDiskBytes: 1_000_000,
	diskFactor: 2.5,
	hasStorageKeys: true,
	vaultSecrets: 0,
	extensionsMissing: [],
	customRoles: [],
	functionCount: 1,
	functionsWithoutJwt: false,
	stoppedWriters: [],
	tlsVerified: true,
	stagingPrefix: "_nitrobase_export",
	stagingTaken: [],
	cronJobs: 0,
	cronMode: "paused",
	...patch,
});

const codes = (items: { code: string | null }[]) =>
	items.map((item) => item.code);

const plugin = SupabasePluginConfigSchema.parse({
	api_service: "kong",
	api_port: 8000,
	studio_service: "studio",
	functions_service: "functions",
	functions_dir: "/home/deno/functions",
	db_service: "db",
	db_user: "supabase_admin",
	db_name: "postgres",
	anon_key: "ANON_KEY",
	service_key: "SERVICE_ROLE_KEY",
	jwt_secret: "JWT_SECRET",
	studio_username: "DASHBOARD_USERNAME",
	studio_password: "DASHBOARD_PASSWORD",
	db_password: "POSTGRES_PASSWORD",
	pooler_tenant: "POOLER_TENANT_ID",
	functions_entrypoints: ["index.ts", "index.js"],
	functions_import_maps: ["deno.json", "import_map.json"],
});

describe("Supabase export: emptiness", () => {
	it("lists what makes a cloud project non-empty", () => {
		expect(cloudContentItems(empty)).toEqual([]);
		expect(
			cloudContentItems({
				...empty,
				relations: ["public.todos"],
				functions: ["public.touch"],
				users: 3,
				buckets: 1,
				vaultSecrets: 2,
				edgeFunctions: ["hello"],
			}),
		).toEqual([
			"public.todos",
			"public.touch()",
			"auth.users: 3",
			"storage.buckets: 1",
			"vault.secrets: 2",
			"functions/hello",
		]);
		const many = cloudContentItems({
			...empty,
			relations: Array.from({ length: 20 }, (_, i) => `public.t${i}`),
		});
		expect(many).toHaveLength(11);
		expect(many.at(-1)).toBe("…");
	});

	it("starts only into an empty, writable project", () => {
		const ok = analyzeExportPreflight(facts());
		expect(ok.blockers).toEqual([]);
		expect(codes(ok.warnings)).toEqual(
			expect.arrayContaining([
				"CLOUD_WARN_EXPORT_KEYS_CHANGE",
				"CLOUD_WARN_SESSIONS",
				"CLOUD_WARN_EXPORT_FUNCTION_SECRETS",
				"CLOUD_WARN_EXPORT_LIVE_WRITES",
				"CLOUD_WARN_EXPORT_NOT_SYNCED",
			]),
		);
		const busy = analyzeExportPreflight(
			facts({ cloud: { ...empty, users: 1 }, canWrite: false }),
		);
		expect(codes(busy.blockers)).toEqual([
			"CLOUD_EXPORT_NOT_EMPTY",
			"CLOUD_EXPORT_DB_READ_ONLY",
		]);
		expect(busy.blockers[0].params).toEqual({
			items: { $list: ["auth.users: 1"] },
		});
	});

	it("refuses a newer local Postgres, missing S3 keys and low disk", () => {
		const result = analyzeExportPreflight(
			facts({
				localMajor: 17,
				cloudMajor: 15,
				hasStorageKeys: false,
				freeDiskBytes: 10,
			}),
		);
		expect(codes(result.blockers)).toEqual([
			"CLOUD_EXPORT_POSTGRES_NEWER",
			"CLOUD_EXPORT_STORAGE_NO_KEYS",
			"CLOUD_SYNC_DISK_LOW",
		]);
		expect(result.blockers[0].params).toEqual({ source: 17, target: 15 });
		// Same major is fine; no disk needed without the database.
		expect(
			analyzeExportPreflight(
				facts({ localMajor: 17, cloudMajor: 17, parts: ["functions"] }),
			).requiredDiskBytes,
		).toBe(0);
		expect(
			codes(
				analyzeExportPreflight(facts({ localMajor: null, parts: ["database"] }))
					.blockers,
			),
		).toEqual(["CLOUD_SYNC_VERSION_UNKNOWN"]);
	});

	it("warns about Vault secrets, extensions, roles, JWT and stopped writers", () => {
		const result = analyzeExportPreflight(
			facts({
				vaultSecrets: 2,
				extensionsMissing: ["timescaledb"],
				customRoles: ["reporting"],
				functionsWithoutJwt: true,
				stoppedWriters: ["auth", "rest"],
			}),
		);
		expect(codes(result.warnings)).toEqual(
			expect.arrayContaining([
				"CLOUD_WARN_EXPORT_VAULT",
				"CLOUD_WARN_EXPORT_EXTENSIONS_MISSING",
				"CLOUD_WARN_ROLE_PASSWORDS",
				"CLOUD_WARN_EXPORT_FUNCTIONS_NO_JWT",
				"CLOUD_WARN_EXPORT_WRITERS_STOPPED",
			]),
		);
		expect(codes(result.warnings)).not.toContain(
			"CLOUD_WARN_EXPORT_LIVE_WRITES",
		);
	});

	it("names one staging schema per job and refuses an app using the prefix", () => {
		expect(
			stagingSchemaName(
				"_nitrobase_export",
				"0F3A9C2E-1234-4ABC-8DEF-001122334455",
			),
		).toBe("_nitrobase_export_0f3a9c2e1234");
		expect(stagingSchemaName("_nitrobase_export", "smoke")).toBe(
			"_nitrobase_export_smoke",
		);
		// Never empty, never past Postgres' 63-byte identifiers.
		expect(stagingSchemaName("_nitrobase_export", "--")).toBeNull();
		expect(stagingSchemaName("x".repeat(60), "abcdef")).toBeNull();
		// Leftovers are recognised (sweep and recovery).
		expect(isStagingSchema("_nitrobase_export_0f3a9c2e1234")).toBe(true);
		expect(isStagingSchema("_nitrobase_export_")).toBe(false);
		expect(isStagingSchema("_nitrobase_exportx_1")).toBe(false);
		expect(isStagingSchema("public")).toBe(false);
		const taken = analyzeExportPreflight(
			facts({ stagingTaken: ["_nitrobase_export_old"] }),
		);
		expect(codes(taken.blockers)).toEqual([
			"CLOUD_EXPORT_STAGING_SCHEMA_TAKEN",
		]);
		expect(taken.blockers[0].params).toEqual({
			prefix: "_nitrobase_export",
			schemas: { $list: ["_nitrobase_export_old"] },
		});
	});

	it("reports the export capability of a tested connection", () => {
		expect(
			exportCapability({
				databaseOk: true,
				databaseError: null,
				canWrite: true,
			}),
		).toEqual({ ok: true });
		expect(
			exportCapability({
				databaseOk: true,
				databaseError: null,
				canWrite: false,
			}).reason?.code,
		).toBe("CLOUD_EXPORT_DB_READ_ONLY");
		const failed = { code: "CLOUD_DB_FAILED", params: {} } as never;
		expect(
			exportCapability({
				databaseOk: false,
				databaseError: failed,
				canWrite: null,
			}),
		).toEqual({ ok: false, reason: failed });
	});
});

describe("Supabase export: commands", () => {
	it("keeps each end's credentials in its own container", () => {
		const dump = pgClientCommand({
			image: "postgres:17.6-alpine",
			workDir: "/w",
			mode: "dump",
			service: "local",
			network: "container:app-db",
			argv: ["pg_dump", "-f", "/dump/data.sql"],
		});
		expect(dump).toContain("-v '/w/secrets:/secrets:ro'");
		expect(dump).toContain("-e PGSERVICE=local");
		const load = pgClientCommand({
			image: "postgres:17.6-alpine",
			workDir: "/w",
			mode: "load",
			service: "cloud",
			argv: ["psql", "-f", "/dump/data.sql"],
		});
		expect(load).toContain("-v '/w/secrets-load:/secrets:ro'");
		expect(load).toContain("-v '/w/dump:/dump:ro'");
		expect(load).toContain("-e PGSERVICE=cloud");
		expect(() =>
			pgClientCommand({
				image: "postgres:17.6-alpine",
				workDir: "/w",
				mode: "load",
				service: "bad service",
				argv: ["psql"],
			}),
		).toThrow();
		expect(prepareSyncWorkDirCommand("/w")).toContain("'/w/secrets-rclone'");
	});

	it("copies buckets from the app to the cloud", () => {
		expect(
			bucketCopyArgs("avatars", 4, "/work/x.log", {
				from: "local",
				to: "cloud",
			}),
		).toEqual(expect.arrayContaining(["local:avatars", "cloud:avatars"]));
		expect(bucketCopyArgs("avatars", 4, "/work/x.log").slice(1, 3)).toEqual([
			"cloud:avatars",
			"local:avatars",
		]);
	});

	it("leaves in-flight uploads (and objects without files) out of the data", () => {
		const args = dumpArgs("data", "/dump/data.sql", {
			excludeTables: [...EXPORT_EXCLUDED_TABLES, "storage.objects"],
		});
		expect(args).toEqual(
			expect.arrayContaining([
				'"storage"."s3_multipart_uploads"',
				'"storage"."s3_multipart_uploads_parts"',
				'"storage"."objects"',
				'"auth"."schema_migrations"',
			]),
		);
		expect(dumpArgs("data", "/dump/data.sql")).not.toContain(
			'"storage"."objects"',
		);
	});
});

describe("Supabase export: edge functions", () => {
	const file = (path: string, text: string) => ({
		path,
		content: Buffer.from(text),
	});

	it("finds the shared folders a function imports", () => {
		expect(
			sharedImports([
				file(
					"index.ts",
					'import { a } from "../_shared/a.ts";\nimport b from "../_utils/b.ts";\nimport c from "./c.ts";',
				),
				file("c.ts", 'import "../_shared/x.ts"; import "../other/y.ts";'),
			]),
		).toEqual(["_shared", "_utils"]);
	});

	it("picks the entrypoint and import map from the template's names", () => {
		const deploy = functionDeploy(plugin, {
			slug: "hello",
			files: [file("deno.json", "{}"), file("index.ts", "x")],
			shared: {},
			verifyJwt: true,
		});
		expect(deploy).toMatchObject({
			entrypoint: "index.ts",
			importMap: "deno.json",
		});
		expect(() =>
			functionDeploy(plugin, {
				slug: "hello",
				files: [file("main.py", "x")],
				shared: {},
				verifyJwt: true,
			}),
		).toThrow(
			expect.objectContaining({
				code: "CLOUD_SYNC_FUNCTION_NO_ENTRYPOINT",
				params: expect.objectContaining({
					name: "hello",
					found: { $list: ["main.py"] },
				}),
			}),
		);
		// A folder imported one level too deep (BUG-013) names its subfolder.
		expect(() =>
			functionDeploy(plugin, {
				slug: "hello",
				files: [file("hello/index.ts", "x")],
				shared: {},
				verifyJwt: true,
			}),
		).toThrow(
			expect.objectContaining({
				params: expect.objectContaining({ found: { $list: ["hello/"] } }),
			}),
		);
	});

	it("names deploy files like the Supabase CLI, bytes kept", () => {
		const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0xff, 0x80]);
		const parts = deployParts({
			slug: "hello",
			entrypoint: "index.ts",
			importMap: null,
			verifyJwt: false,
			files: [file("index.ts", "x"), { path: "mod.wasm", content: wasm }],
			shared: { _shared: [file("cors.ts", "y")] },
		});
		expect(parts[0]).toMatchObject({ name: "metadata" });
		expect(JSON.parse(String(parts[0].data))).toEqual({
			name: "hello",
			entrypoint_path: `${FUNCTION_UPLOAD_ROOT}/hello/index.ts`,
			verify_jwt: false,
		});
		expect(parts.slice(1).map((part) => part.filename)).toEqual([
			`${FUNCTION_UPLOAD_ROOT}/hello/index.ts`,
			`${FUNCTION_UPLOAD_ROOT}/hello/mod.wasm`,
			`${FUNCTION_UPLOAD_ROOT}/_shared/cors.ts`,
		]);
		// The body round-trips through the multipart parser byte for byte.
		const body = buildMultipart(parts, "b0undary");
		const parsed = parseMultipart(body, "b0undary");
		expect(parsed.map((part) => part.name)).toEqual([
			"metadata",
			"file",
			"file",
			"file",
		]);
		expect(Buffer.compare(parsed[2].data, wasm)).toBe(0);
		expect(() => buildMultipart(parts, "bad boundary\r\n")).toThrow();
	});
});
