import { describe, expect, it, vi } from "vitest";
import { looksLikeFile } from "#/config/bind-files.ts";
import {
	appBindSources,
	assertBindSourcesFetched,
	declaredDataPaths,
	fileBindSources,
	needsUpstreamListing,
	unwrittenBindSources,
} from "./bind-sources";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const ROOT = "/etc/nitrobase/apps/appwrite-ad07dc68";

/** A transformed compose model (bind sources are absolute by then). */
const model = {
	services: {
		clickhouse: {
			volumes: [
				"appwrite-clickhouse:/var/lib/clickhouse:rw",
				`${ROOT}/clickhouse-config.xml:/etc/clickhouse-server/config.d/appwrite.xml:ro`,
				`${ROOT}/clickhouse-init.sh:/docker-entrypoint-initdb.d/clickhouse-init.sh:ro`,
			],
		},
		mongodb: {
			volumes: [
				{
					type: "bind",
					source: `${ROOT}/mongo-init.js`,
					target: "/mongo-init.js",
				},
			],
		},
		db: {
			volumes: [
				`${ROOT}/volumes/db/data:/var/lib/postgresql/data:Z`,
				`${ROOT}/volumes/db/roles.sql:/docker-entrypoint-initdb.d/roles.sql:Z`,
				`${ROOT}/volumes/functions:/home/deno/functions:z`,
				`${ROOT}/pb_data:/pb/pb_data`,
				`${ROOT}/backup.d/dumps.sql:/dumps.sql`,
				"/srv/media:/media",
				{ type: "tmpfs", target: "/tmp" },
			],
		},
	},
};

describe("bind sources in the app folder", () => {
	it("lists bind sources inside the app folder only (short and long syntax)", () => {
		expect(appBindSources(model, ROOT)).toEqual([
			{ service: "clickhouse", path: "clickhouse-config.xml" },
			{ service: "clickhouse", path: "clickhouse-init.sh" },
			{ service: "mongodb", path: "mongo-init.js" },
			{ service: "db", path: "volumes/db/data" },
			{ service: "db", path: "volumes/db/roles.sql" },
			{ service: "db", path: "volumes/functions" },
			{ service: "db", path: "pb_data" },
			{ service: "db", path: "backup.d/dumps.sql" },
		]);
	});

	it("leaves out written files and folders holding written files", () => {
		const unwritten = unwrittenBindSources({
			composeModel: model,
			appRoot: ROOT,
			files: [
				{ path: "mongo-init.js" },
				{ path: "volumes/db/roles.sql" },
				{ path: "volumes/functions/main/index.ts" },
			],
		});
		expect(unwritten.map((bind) => bind.path)).toEqual([
			"clickhouse-config.xml",
			"clickhouse-init.sh",
			"volumes/db/data",
			"pb_data",
			"backup.d/dumps.sql",
		]);
	});

	it("refuses an unwritten bind source upstream has as a file (appwrite 2.4.0)", () => {
		const unwritten = unwrittenBindSources({
			composeModel: model,
			appRoot: ROOT,
			files: [{ path: "mongo-init.js" }],
		});
		expect(() =>
			assertBindSourcesFetched(
				unwritten,
				new Set(["docker-compose.yml", "clickhouse-init.sh"]),
			),
		).toThrow(
			expect.objectContaining({
				code: "TEMPLATE_BIND_SOURCE_MISSING",
				params: { service: "clickhouse", path: "clickhouse-init.sh" },
			}),
		);
		// Data folders are not upstream files: nothing to refuse.
		expect(() =>
			assertBindSourcesFetched(unwritten, new Set(["volumes/db/.gitkeep"])),
		).not.toThrow();
	});

	it("expects files for written binds and file-named sources, never data folders", () => {
		const binds = fileBindSources({
			composeModel: model,
			appRoot: ROOT,
			files: [{ path: "mongo-init.js" }, { path: "volumes/functions/a.ts" }],
			dataPaths: ["backup.d", "./clickhouse-config.xml"],
		});
		expect(binds).toEqual({
			// Written by the deploy: hard check.
			required: [{ service: "mongodb", path: "mongo-init.js" }],
			// Named like files, written by nothing, not declared: soft check.
			named: [
				{ service: "clickhouse", path: "clickhouse-init.sh" },
				{ service: "db", path: "volumes/db/roles.sql" },
			],
		});
	});

	it("declared runtime data is neither a candidate nor checked", () => {
		const unwritten = unwrittenBindSources({
			composeModel: model,
			appRoot: ROOT,
			files: [{ path: "mongo-init.js" }],
			dataPaths: declaredDataPaths({
				data_binds: ["clickhouse-init.sh", "clickhouse-config.xml"],
				backup: {
					paths: ["pb_data"],
					reset: ["volumes/db"],
					volumes: [],
					stop: true,
					reset_volumes: [],
					hooks: [],
				},
			}),
		});
		expect(unwritten.map((bind) => bind.path)).toEqual([
			"volumes/functions",
			"backup.d/dumps.sql",
		]);
		expect(() =>
			assertBindSourcesFetched(unwritten, new Set(["clickhouse-init.sh"])),
		).not.toThrow();
	});

	it("lists upstream only when a candidate is named like a file", () => {
		expect(
			needsUpstreamListing([
				{ service: "db", path: "volumes/db/data" },
				{ service: "db", path: "pb_data" },
			]),
		).toBe(false);
		expect(needsUpstreamListing([])).toBe(false);
		expect(
			needsUpstreamListing([
				{ service: "db", path: "volumes/db/data" },
				{ service: "clickhouse", path: "clickhouse-init.sh" },
			]),
		).toBe(true);
	});
});

describe("file-like bind source names", () => {
	it.each([
		["clickhouse-init.sh", true],
		["clickhouse-config.xml", true],
		["volumes/api/kong.yml", true],
		["volumes/proxy/caddy/Caddyfile", true],
		["nginx/conf.d", false],
		["volumes/db/data", false],
		["pb_data", false],
		["data.v2", false],
		[".hidden", false],
		["conf/", false],
	])("%s → %s", (source, expected) => {
		expect(looksLikeFile(source)).toBe(expected);
	});
});
