import { describe, expect, it } from "vitest";
import { buildTar } from "#/server/services/supabase/edge-functions.ts";
import { multipartBoundary, parseMultipart } from "./multipart";
import { parseBucketNames, signS3Request } from "./sigv4";
import {
	assertFunctionEntrypoint,
	FUNCTION_UPLOAD_ROOT,
	functionSource,
	pickSessionPooler,
	postgresMajor,
	type SupabasePooler,
	topLevelEntries,
} from "./supabase-api";

const pooler = (over: Partial<SupabasePooler>): SupabasePooler => ({
	database_type: "PRIMARY",
	pool_mode: "transaction",
	db_host: "aws-1-eu-central-1.pooler.supabase.com",
	db_port: 6543,
	db_user: "postgres.abcdefghijklmnopqrst",
	db_name: "postgres",
	...over,
});

describe("Management API answers", () => {
	it("picks the primary session pooler", () => {
		expect(
			pickSessionPooler([
				pooler({ database_type: "READ_REPLICA", pool_mode: "session" }),
				pooler({}),
				pooler({ pool_mode: "session", db_port: 5432 }),
			])?.db_port,
		).toBe(5432);
		expect(pickSessionPooler([pooler({})])).toBeNull();
	});

	it("reads Postgres majors", () => {
		expect(postgresMajor("17.4.1.054")).toBe(17);
		expect(postgresMajor("15.8.1.093")).toBe(15);
		expect(postgresMajor("")).toBeNull();
		expect(postgresMajor(undefined)).toBeNull();
	});
});

const BOUNDARY = "xYzBoundary";
const part = (headers: string[], body: string) =>
	`--${BOUNDARY}\r\n${headers.join("\r\n")}\r\n\r\n${body}\r\n`;

describe("function source download (multipart)", () => {
	const body = Buffer.from(
		[
			part(
				['Content-Disposition: form-data; name="metadata"'],
				JSON.stringify({
					deno2_entrypoint_path: "file:///tmp/user_fn_x/source/index.ts",
				}),
			),
			part(
				[
					'Content-Disposition: form-data; name="file"; filename="/tmp/user_fn_x/source/index.ts"',
				],
				'import { x } from "../_shared/util.ts";',
			),
			part(
				[
					'Content-Disposition: form-data; name="file"; filename="ignored"',
					"Supabase-Path: /tmp/user_fn_x/source/lib/a.ts",
				],
				"export const a = 1;",
			),
			part(
				[
					'Content-Disposition: form-data; name="file"; filename="/tmp/user_fn_x/_shared/util.ts"',
				],
				"export const x = 2;",
			),
			part(
				[
					'Content-Disposition: form-data; name="file"; filename="/tmp/user_fn_x/source/../../../etc/passwd"',
				],
				"root",
			),
			part(
				[
					'Content-Disposition: form-data; name="file"; filename="/tmp/user_fn_x/other/x.ts"',
				],
				"nope",
			),
			`--${BOUNDARY}--\r\n`,
		].join(""),
	);

	it("finds the boundary", () => {
		expect(multipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(
			BOUNDARY,
		);
		expect(multipartBoundary('multipart/form-data; boundary="a b"')).toBe(
			"a b",
		);
		expect(multipartBoundary("application/octet-stream")).toBeNull();
	});

	it("maps paths to the function folder and shared folders", () => {
		const source = functionSource(parseMultipart(body, BOUNDARY), null);
		const text = (files: { path: string; content: string | Buffer }[]) =>
			files.map((file) => ({ path: file.path, content: String(file.content) }));
		expect(text(source.files)).toEqual([
			{ path: "index.ts", content: 'import { x } from "../_shared/util.ts";' },
			{ path: "lib/a.ts", content: "export const a = 1;" },
		]);
		expect(text(source.shared._shared ?? [])).toEqual([
			{ path: "util.ts", content: "export const x = 2;" },
		]);
	});

	it("keeps binary files byte for byte, into the deploy tar", () => {
		// A wasm header plus bytes that are not valid UTF-8.
		const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0xff, 0x80, 0xfe]);
		const binary = Buffer.concat([
			Buffer.from(
				`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="/tmp/f/source/index.ts"\r\n\r\nx\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="/tmp/f/source/mod.wasm"\r\nContent-Type: application/wasm\r\n\r\n`,
			),
			wasm,
			Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
		]);
		const source = functionSource(
			parseMultipart(binary, BOUNDARY),
			"file:///tmp/f/source/index.ts",
		);
		const file = source.files.find((item) => item.path === "mod.wasm");
		expect(Buffer.isBuffer(file?.content)).toBe(true);
		expect(Buffer.compare(file?.content as Buffer, wasm)).toBe(0);
		const tar = buildTar(".staging-x", [
			file as { path: string; content: Buffer },
		]);
		// The file's bytes follow its 512-byte header unchanged.
		const header = tar.indexOf(".staging-x/mod.wasm");
		expect(header % 512).toBe(0);
		expect(
			Buffer.compare(
				tar.subarray(header + 512, header + 512 + wasm.length),
				wasm,
			),
		).toBe(0);
	});

	it("never maps server paths outside the functions folder", () => {
		const source = functionSource(parseMultipart(body, BOUNDARY), null);
		expect(source.skipped).toEqual([
			"/tmp/user_fn_x/source/../../../etc/passwd",
			"/tmp/user_fn_x/other/x.ts",
		]);
	});

	it("falls back to the function's entrypoint path", () => {
		const parts = parseMultipart(body, BOUNDARY).filter(
			(item) => item.name !== "metadata",
		);
		const source = functionSource(
			parts,
			"file:///tmp/user_fn_x/source/index.ts",
		);
		expect(source.files.map((file) => file.path)).toEqual([
			"index.ts",
			"lib/a.ts",
		]);
	});

	it("reports the entrypoint inside the function folder", () => {
		const source = functionSource(parseMultipart(body, BOUNDARY), null);
		expect(source.entrypoint).toBe("index.ts");
	});

	it("refuses truncated bodies", () => {
		expect(() =>
			parseMultipart(body.subarray(0, body.length - 30), BOUNDARY),
		).toThrow();
	});
});

describe("function source layouts (BUG-013)", () => {
	const download = (
		entrypoint: string | null,
		files: { path: string; content?: string; header?: boolean }[],
	) => {
		const raw = Buffer.from(
			[
				...(entrypoint === null
					? []
					: [
							part(
								['Content-Disposition: form-data; name="metadata"'],
								JSON.stringify({ deno2_entrypoint_path: entrypoint }),
							),
						]),
				...files.map((item) =>
					part(
						item.header
							? [
									'Content-Disposition: form-data; name="file"; filename="x"',
									`Supabase-Path: ${item.path}`,
								]
							: [
									`Content-Disposition: form-data; name="file"; filename="${item.path}"`,
								],
						item.content ?? item.path,
					),
				),
				`--${BOUNDARY}--\r\n`,
			].join(""),
		);
		return parseMultipart(raw, BOUNDARY);
	};
	const layout = (source: ReturnType<typeof functionSource>) => ({
		files: source.files.map((file) => file.path),
		shared: Object.fromEntries(
			Object.entries(source.shared).map(([dir, list]) => [
				dir,
				list.map((file) => file.path),
			]),
		),
		skipped: source.skipped,
		entrypoint: source.entrypoint,
	});

	it("maps the CLI --use-api relative layout with _shared", () => {
		const source = functionSource(
			download("functions/qa-shared/index.ts", [
				{ path: "functions/qa-shared/index.ts" },
				{ path: "functions/qa-shared/lib/a.ts", header: true },
				{ path: "functions/_shared/greet.ts" },
			]),
			null,
		);
		expect(layout(source)).toEqual({
			files: ["index.ts", "lib/a.ts"],
			shared: { _shared: ["greet.ts"] },
			skipped: [],
			entrypoint: "index.ts",
		});
		// Contents follow their part.
		expect(String(source.shared._shared?.[0]?.content)).toBe(
			"functions/_shared/greet.ts",
		);
	});

	it("maps a single relative function at the folder root", () => {
		expect(
			layout(
				functionSource(
					download("hello/index.ts", [{ path: "hello/index.ts" }]),
					null,
				),
			),
		).toEqual({
			files: ["index.ts"],
			shared: {},
			skipped: [],
			entrypoint: "index.ts",
		});
	});

	it("round-trips our own deploy names (deployParts)", () => {
		const root = `${FUNCTION_UPLOAD_ROOT}/hello`;
		const parts = download(`${root}/index.ts`, [
			{ path: `${root}/index.ts` },
			{ path: `${root}/deno.json` },
			{ path: `${FUNCTION_UPLOAD_ROOT}/_shared/cors.ts` },
		]);
		expect(layout(functionSource(parts, null))).toEqual({
			files: ["index.ts", "deno.json"],
			shared: { _shared: ["cors.ts"] },
			skipped: [],
			entrypoint: "index.ts",
		});
		// The function's stored entrypoint URL, when the metadata lacks it.
		expect(
			layout(
				functionSource(
					parts.filter((item) => item.name !== "metadata"),
					`file:///tmp/user_fn_x/source/${root}/index.ts`,
				),
			).files,
		).toEqual(["index.ts", "deno.json"]);
	});

	it("anchors relative parts on an absolute entrypoint", () => {
		expect(
			layout(
				functionSource(
					download("file:///tmp/user_fn_x/source/functions/hello/index.ts", [
						{ path: "functions/hello/index.ts" },
						{ path: "functions/hello/lib/a.ts" },
						{ path: "functions/_shared/x.ts" },
					]),
					null,
				),
			),
		).toEqual({
			files: ["index.ts", "lib/a.ts"],
			shared: { _shared: ["x.ts"] },
			skipped: [],
			entrypoint: "index.ts",
		});
		// No common suffix: relative parts resolve from the entrypoint folder.
		expect(
			layout(
				functionSource(
					download("file:///tmp/user_fn_x/source/index.ts", [
						{ path: "main.ts" },
						{ path: "lib/a.ts" },
					]),
					null,
				),
			).files,
		).toEqual(["main.ts", "lib/a.ts"]);
	});

	it("anchors a relative entrypoint on an absolute part", () => {
		expect(
			layout(
				functionSource(
					download("hello/index.ts", [
						{ path: "/tmp/f/source/hello/index.ts" },
						{ path: "hello/lib/a.ts" },
					]),
					null,
				),
			).files,
		).toEqual(["index.ts", "lib/a.ts"]);
	});

	it("skips relative paths that escape the common root", () => {
		expect(
			layout(
				functionSource(
					download("functions/hello/index.ts", [
						{ path: "functions/hello/index.ts" },
						{ path: "functions/hello/../../../etc/passwd" },
						{ path: "functions/other/x.ts" },
					]),
					null,
				),
			),
		).toEqual({
			files: ["index.ts"],
			shared: {},
			skipped: ["functions/hello/../../../etc/passwd", "functions/other/x.ts"],
			entrypoint: "index.ts",
		});
	});

	it("leaves a source without an entrypoint for the import check", () => {
		const source = functionSource(
			download(null, [{ path: "hello/index.ts" }]),
			null,
		);
		expect(layout(source)).toEqual({
			files: ["hello/index.ts"],
			shared: {},
			skipped: [],
			entrypoint: null,
		});
		expect(topLevelEntries(source.files.map((file) => file.path))).toEqual([
			"hello/",
		]);
		expect(() =>
			assertFunctionEntrypoint("hello", source, ["index.ts", "index.js"]),
		).toThrow(
			expect.objectContaining({
				code: "CLOUD_FUNCTION_NO_ENTRYPOINT",
				params: {
					name: "hello",
					expected: { $list: ["index.ts", "index.js"] },
					found: { $list: ["hello/"] },
				},
			}),
		);
	});

	it("accepts the template's or the reported entrypoint at the root", () => {
		const source = functionSource(
			download("functions/hello/main.ts", [
				{ path: "functions/hello/main.ts" },
			]),
			null,
		);
		expect(() =>
			assertFunctionEntrypoint("hello", source, ["index.ts"]),
		).not.toThrow();
		expect(() =>
			assertFunctionEntrypoint("hello", { ...source, entrypoint: null }, [
				"index.ts",
			]),
		).toThrow();
	});
});

describe("S3 signing for the connection test", () => {
	it("signs a bodyless GET with SigV4", () => {
		const headers = signS3Request({
			method: "GET",
			url: new URL("https://abc.storage.supabase.co/storage/v1/s3/"),
			region: "eu-central-1",
			accessKeyId: "AKID",
			secretAccessKey: "SECRET",
			now: new Date("2026-10-07T12:00:00Z"),
		});
		expect(headers["x-amz-date"]).toBe("20261007T120000Z");
		expect(headers["x-amz-content-sha256"]).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(headers.authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKID\/20261007\/eu-central-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
		);
		expect(headers.authorization).not.toContain("SECRET");
	});

	it("reads bucket names", () => {
		expect(
			parseBucketNames(
				"<ListAllMyBucketsResult><Buckets><Bucket><Name>avatars</Name><CreationDate>x</CreationDate></Bucket><Bucket><Name>docs</Name></Bucket></Buckets></ListAllMyBucketsResult>",
			),
		).toEqual(["avatars", "docs"]);
	});
});
