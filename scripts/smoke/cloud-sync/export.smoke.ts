import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sleep } from "#/libs/async.ts";

/**
 * Smoke test of the Supabase EXPORT (a self-hosted app → an empty hosted
 * project) on this machine's Docker (see vitest.config.ts):
 * - the "app": <p>-x-db (supabase/postgres seeded like a used app: tables,
 *   a trigger, RLS, auth users, storage rows, a Vault secret, a custom
 *   role), <p>-x-s3local (its storage S3 endpoint with the files),
 *   <p>-x-functions (edge function folders, a shared folder, a wasm file),
 *   <p>-x-rest (a writer the export stops and starts again);
 * - the fake cloud: <p>-x-cloud (supabase/postgres, fresh, reached as
 *   `postgres` like the session pooler's `postgres.<ref>`), <p>-x-s3cloud
 *   (an S3 server), and a mock Management API in this process
 *   (127.0.0.1:<port>): project, session pooler, functions list and the
 *   functions deploy endpoint (multipart, stored for the checks).
 * The driver's own test, preflight, emptiness check and export steps run
 * through a SyncTarget on the local executor; a second preflight on the
 * now non-empty project must refuse. Everything is removed afterwards.
 */

const PG_IMAGE = "supabase/postgres:17.6.1.136";
const S3_IMAGE = "rustfs/rustfs:1.0.1";
const BOX_IMAGE = "debian:stable-slim";
const RCLONE_IMAGE = "rclone/rclone:1.71.1";
const P = `${process.env.SMOKE_PREFIX ?? "cs-agent"}-x`;
const NET = `${process.env.SMOKE_PREFIX ?? "cs-agent"}-net`;
const PORT = Number(process.env.SMOKE_API_PORT ?? 3102);
const ROOT = `/private/tmp/${process.env.SMOKE_PREFIX ?? "cs-agent"}-smoke`;
const REF = "smokeexportrefabcdef";
const TOKEN = "sbp_smoke_export_token_0123";
const CLOUD_PW = "cloud-postgres-password-321";
const LOCAL_PW = "local-db-password-654";
const S3_CLOUD = { id: "cloudaccesskey", secret: "cloud-s3-secret-987" };
const S3_LOCAL = { id: "localaccesskey", secret: "local-s3-secret-210" };
const CONTAINERS = ["cloud", "db", "s3cloud", "s3local", "functions", "rest"].map(
	(name) => `${P}-${name}`,
);
const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0xff, 0x80, 0xfe]);

function docker(args: string[], input?: string | Buffer, timeout = 300_000) {
	const result = spawnSync("docker", args, { input, timeout });
	if (result.status !== 0) {
		throw new Error(
			`docker ${args.slice(0, 3).join(" ")} failed: ${result.stderr?.toString() || result.error}`,
		);
	}
	return result.stdout.toString().trim();
}

async function waitPostgres(container: string) {
	for (let i = 0; i < 120; i++) {
		const ok = spawnSync(
			"docker",
			["exec", container, "pg_isready", "-h", "localhost", "-q"],
			{ timeout: 10_000 },
		);
		if (ok.status === 0) {
			await sleep(3000);
			const again = spawnSync(
				"docker",
				["exec", container, "pg_isready", "-h", "localhost", "-q"],
				{ timeout: 10_000 },
			);
			if (again.status === 0) return;
		}
		await sleep(1000);
	}
	throw new Error(`${container} did not start`);
}

const sql = (container: string, text: string) =>
	docker(
		[
			"exec",
			"-i",
			container,
			"psql",
			"-X",
			"-q",
			"-A",
			"-t",
			"-v",
			"ON_ERROR_STOP=1",
			"-U",
			"supabase_admin",
			"-d",
			"postgres",
		],
		text,
	);

const ip = (container: string) =>
	docker([
		"inspect",
		"-f",
		`{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`,
		container,
	]);

const rclone = (endpoint: string, keys: { id: string; secret: string }) => [
	"run",
	"--rm",
	"-i",
	"--network",
	NET,
	"-e",
	"RCLONE_CONFIG_S_TYPE=s3",
	"-e",
	"RCLONE_CONFIG_S_PROVIDER=Other",
	"-e",
	`RCLONE_CONFIG_S_ENDPOINT=${endpoint}`,
	"-e",
	`RCLONE_CONFIG_S_ACCESS_KEY_ID=${keys.id}`,
	"-e",
	`RCLONE_CONFIG_S_SECRET_ACCESS_KEY=${keys.secret}`,
	"-e",
	"RCLONE_CONFIG_S_FORCE_PATH_STYLE=true",
	"-e",
	"RCLONE_CONFIG_S_REGION=us-east-1",
	RCLONE_IMAGE,
];

/**
 * What the storage service's migrations create (the bare image has no
 * storage tables), on both sides. In the cloud, `postgres` may write them
 * (as on a hosted project).
 */
const STORAGE_SCHEMA = `
create schema if not exists storage;
create table if not exists storage.migrations (id integer primary key, name text, hash text, executed_at timestamptz default now());
create table if not exists storage.buckets (id text primary key, name text not null, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
  name text, owner uuid, owner_id text, metadata jsonb, user_metadata jsonb, version text, created_at timestamptz default now(),
  updated_at timestamptz default now(), last_accessed_at timestamptz default now());
insert into storage.migrations (id, name, hash) values (0, 'create-migrations-table', 'x') on conflict do nothing;
grant usage on schema storage to postgres;
grant all on all tables in schema storage to postgres;
`;

const SEED = `
create schema app;
create table public.todos (id bigint generated always as identity primary key, title text not null, done boolean default false);
insert into public.todos (title) select 'todo ' || g from generate_series(1, 25) g;
create table app.notes (id serial primary key, todo_id bigint references public.todos (id), body text);
insert into app.notes (todo_id, body) select g, 'note ' || g from generate_series(1, 5) g;
create function public.touch() returns trigger language plpgsql as $$ begin new.title := new.title || '!'; return new; end $$;
create trigger todos_touch before insert on public.todos for each row execute function public.touch();
alter table public.todos enable row level security;
create policy "read todos" on public.todos for select to anon using (true);
grant select on public.todos to anon;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    'u' || g || '@example.com', extensions.crypt('pw', extensions.gen_salt('bf')), now(), now()
  from generate_series(1, 3) g;
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('avatars', 'a.txt', (select id from auth.users order by email limit 1), '{"size": 5}'),
  ('avatars', 'dir/b.txt', null, '{"size": 6}');
select vault.create_secret('s3cret-value', 'api_key');
create role reporting login password 'reportpw';
grant select on public.todos to reporting;
`;

/** Functions the mock Management API received, by slug. */
const deployed = new Map<
	string,
	{ metadata: Record<string, unknown>; files: Map<string, Buffer> }
>();
let server: http.Server;
let cloudIp = "";
const apiCalls: string[] = [];

function parseForm(body: Buffer, boundary: string) {
	const parts: { name: string; filename: string | null; data: Buffer }[] = [];
	const delimiter = Buffer.from(`--${boundary}`);
	let at = body.indexOf(delimiter);
	while (at >= 0) {
		const start = at + delimiter.length;
		if (body.subarray(start, start + 2).toString() === "--") break;
		const headerEnd = body.indexOf("\r\n\r\n", start);
		const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd);
		const headers = body.subarray(start + 2, headerEnd).toString();
		parts.push({
			name: /name="([^"]+)"/.exec(headers)?.[1] ?? "",
			filename: /filename="([^"]+)"/.exec(headers)?.[1] ?? null,
			data: body.subarray(headerEnd + 4, next),
		});
		at = next + 2;
	}
	return parts;
}

function startMockApi(): Promise<void> {
	server = http.createServer((request, response) => {
		apiCalls.push(`${request.method} ${request.url}`);
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			if (request.headers.authorization !== `Bearer ${TOKEN}`) {
				response.writeHead(401).end('{"message":"unauthorized"}');
				return;
			}
			const json = (value: unknown, status = 200) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(value));
			};
			const base = `/v1/projects/${REF}`;
			const url = new URL(request.url ?? "/", "http://mock");
			if (request.method === "GET" && url.pathname === base) {
				return json({
					ref: REF,
					name: "Empty project",
					region: "us-east-1",
					status: "ACTIVE_HEALTHY",
					database: { host: `db.${REF}.supabase.co`, version: "17.6.1.136" },
				});
			}
			if (url.pathname === `${base}/config/database/pooler`) {
				return json([
					{
						database_type: "PRIMARY",
						pool_mode: "session",
						db_host: cloudIp,
						db_port: 5432,
						db_user: "postgres",
						db_name: "postgres",
					},
				]);
			}
			if (request.method === "GET" && url.pathname === `${base}/functions`) {
				return json(
					[...deployed.keys()].map((slug, index) => ({
						id: String(index),
						slug,
						name: slug,
						status: "ACTIVE",
						version: 1,
					})),
				);
			}
			if (
				request.method === "POST" &&
				url.pathname === `${base}/functions/deploy`
			) {
				const slug = url.searchParams.get("slug") ?? "";
				const boundary =
					/boundary=([^;]+)/.exec(request.headers["content-type"] ?? "")?.[1] ??
					"";
				const parts = parseForm(Buffer.concat(chunks), boundary);
				const metadata = JSON.parse(
					parts.find((part) => part.name === "metadata")?.data.toString() ??
						"{}",
				);
				const files = new Map(
					parts
						.filter((part) => part.name === "file" && part.filename)
						.map((part) => [part.filename ?? "", Buffer.from(part.data)]),
				);
				deployed.set(slug, { metadata, files });
				return json(
					{ id: slug, slug, name: slug, status: "ACTIVE", version: 1 },
					201,
				);
			}
			response.writeHead(404).end("{}");
		});
	});
	return new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
}

function cleanup() {
	for (const name of CONTAINERS) {
		spawnSync("docker", ["rm", "-f", "-v", name], { timeout: 60_000 });
	}
	spawnSync("docker", ["network", "rm", NET], { timeout: 60_000 });
	rmSync(ROOT, { recursive: true, force: true });
}

beforeAll(async () => {
	cleanup();
	mkdirSync(`${ROOT}/root/backup-work`, { recursive: true });
	docker(["network", "create", NET]);
	const pg = (name: string, password: string) =>
		docker([
			"run",
			"-d",
			"--name",
			name,
			"--network",
			NET,
			"-e",
			`POSTGRES_PASSWORD=${password}`,
			PG_IMAGE,
			"postgres",
			"-c",
			"config_file=/etc/postgresql/postgresql.conf",
		]);
	pg(`${P}-db`, LOCAL_PW);
	pg(`${P}-cloud`, CLOUD_PW);
	for (const [name, keys] of [
		[`${P}-s3cloud`, S3_CLOUD],
		[`${P}-s3local`, S3_LOCAL],
	] as const) {
		docker([
			"run",
			"-d",
			"--name",
			name,
			"--network",
			NET,
			"-e",
			`RUSTFS_ACCESS_KEY=${keys.id}`,
			"-e",
			`RUSTFS_SECRET_KEY=${keys.secret}`,
			S3_IMAGE,
		]);
	}
	docker([
		"run",
		"-d",
		"--name",
		`${P}-functions`,
		"--network",
		NET,
		BOX_IMAGE,
		"sh",
		"-c",
		"mkdir -p /home/deno/functions/main /home/deno/functions/hello /home/deno/functions/_shared && exec sleep 100000",
	]);
	docker([
		"run",
		"-d",
		"--name",
		`${P}-rest`,
		"--network",
		NET,
		BOX_IMAGE,
		"sleep",
		"100000",
	]);
	const write = (path: string, content: string | Buffer) =>
		docker(
			[
				"exec",
				"-i",
				`${P}-functions`,
				"sh",
				"-c",
				'cat > "$1"',
				"sh",
				`/home/deno/functions/${path}`,
			],
			content,
		);
	write(
		"hello/index.ts",
		'import { greet } from "../_shared/greet.ts";\nDeno.serve(() => new Response(greet()));\n',
	);
	write("hello/mod.wasm", WASM);
	write("_shared/greet.ts", 'export const greet = () => "hello";\n');
	write("main/index.ts", "// router\n");
	await waitPostgres(`${P}-db`);
	await waitPostgres(`${P}-cloud`);
	sql(`${P}-db`, STORAGE_SCHEMA);
	sql(`${P}-cloud`, STORAGE_SCHEMA);
	sql(`${P}-db`, SEED);
	// The pooler user of a hosted project: `postgres` with its password.
	sql(`${P}-cloud`, `alter role postgres with login password '${CLOUD_PW}'`);
	cloudIp = ip(`${P}-cloud`);
	const s3CloudIp = ip(`${P}-s3cloud`);
	await sleep(3000);
	// The hosted S3 endpoint addresses buckets by their storage rows; the
	// stand-in S3 server needs the bucket itself.
	docker([...rclone(`http://${P}-s3cloud:9000`, S3_CLOUD), "mkdir", "s:avatars"]);
	const local = rclone(`http://${P}-s3local:9000`, S3_LOCAL);
	docker([...local, "mkdir", "s:avatars"]);
	docker([...local, "rcat", "s:avatars/a.txt"], "hello");
	docker([...local, "rcat", "s:avatars/dir/b.txt"], "world!");
	process.env.CLOUD_SYNC_SUPABASE_S3_URL = `http://${s3CloudIp}:9000`;
	process.env.CLOUD_SYNC_EXTRA_ALLOWED_HOSTS = `127.0.0.1,${cloudIp},${s3CloudIp}`;
	await startMockApi();
});

afterAll(async () => {
	if (server) await new Promise((resolve) => server.close(resolve));
	cleanup();
});

describe("Supabase export into a fake empty cloud", () => {
	it("tests, previews, exports database, storage and functions, then refuses a non-empty project", async () => {
		const { getCloudSyncProvider } = await import("#/config/cloud-sync.ts");
		const { supabaseDriver } = await import(
			"#/server/services/cloud-sync/supabase.ts"
		);
		const { LocalExecutor } = await import("#/server/services/local.ts");
		const { redactor } = await import("#/server/services/backup/rclone.ts");
		const { redactCodedParams } = await import("#/libs/coded.ts");
		const { hostPaths } = await import("#/config/server.ts");
		const { prepareSyncWorkDirCommand } = await import(
			"#/server/services/cloud-sync/commands.ts"
		);
		const { commandError } = await import("#/utils/error.ts");
		const { SupabasePluginConfigSchema } = await import(
			"#/features/supabase/schema.ts"
		);

		const provider = getCloudSyncProvider("supabase");
		if (!provider) throw new Error("no provider");
		const config = {
			projectRef: REF,
			accessToken: TOKEN,
			dbPassword: CLOUD_PW,
			s3AccessKeyId: S3_CLOUD.id,
			s3SecretAccessKey: S3_CLOUD.secret,
		};
		const secrets = [
			TOKEN,
			CLOUD_PW,
			LOCAL_PW,
			S3_CLOUD.secret,
			S3_LOCAL.secret,
		];
		const redact = redactor(secrets);

		// 1. Connection test: both directions possible (postgres may write).
		const test = await supabaseDriver.test(provider, config);
		console.info("test", JSON.stringify(test));
		expect(test.directions).toEqual([
			{ direction: "import", ok: true, reason: null },
			{ direction: "export", ok: true },
		]);

		// The app as the job reaches it.
		const localExec = new LocalExecutor();
		const executor = {
			kind: "local" as const,
			exec: localExec.exec.bind(localExec),
			shell: localExec.shell.bind(localExec),
			close: () => undefined,
			upload: async (content: string | Buffer, path: string, mode = "0644") => {
				mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
				writeFileSync(path, content, { mode: Number.parseInt(mode, 8) });
				chmodSync(path, Number.parseInt(mode, 8));
			},
			readFile: async (path: string) => readFileSync(path, "utf8"),
		};
		const workDir = `${hostPaths().backupWork}/cloud-export-smoke`;
		await executor.exec(prepareSyncWorkDirCommand(workDir));
		const container = (service: string) => `${P}-${service}`;
		const run = async (
			command: string,
			failure: unknown,
			options: { input?: string | Buffer } = {},
		) => {
			const result = await executor.exec(command, {
				input: options.input,
				timeoutMs: 600_000,
			});
			if (result.exitCode !== 0) {
				const detail = redact(result.stderr || result.stdout);
				throw typeof failure === "function"
					? failure(detail)
					: commandError(failure as never, detail);
			}
			return result.stdout;
		};
		const composeCalls: string[] = [];
		const compose = async (args: string[], failure: unknown) => {
			const [verb, ...rest] = args.filter((arg) => !arg.startsWith("-"));
			composeCalls.push(`${verb} ${rest.join(" ")}`);
			const dockerVerb = verb === "up" ? "start" : verb;
			return run(`docker ${dockerVerb} ${rest.map(container).join(" ")}`, failure);
		};
		const pluginConfig = SupabasePluginConfigSchema.parse({
			api_service: "s3local",
			api_port: 9000,
			studio_service: "studio",
			functions_service: "functions",
			functions_dir: "/home/deno/functions",
			functions_reserved: ["main"],
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
			db_port_variable: "POSTGRES_PORT",
			storage_s3_path: "/",
			storage_region: "REGION",
			storage_s3_key_id: "S3_PROTOCOL_ACCESS_KEY_ID",
			storage_s3_key_secret: "S3_PROTOCOL_ACCESS_KEY_SECRET",
			sync_export_writer_services: ["rest"],
			functions_verify_jwt: "FUNCTIONS_VERIFY_JWT",
			functions_entrypoints: ["index.ts", "index.js"],
			functions_import_maps: ["deno.json", "import_map.json"],
		});
		const target = {
			executor,
			workDir,
			appName: "smoke",
			pluginConfig,
			values: {
				POSTGRES_PASSWORD: LOCAL_PW,
				POSTGRES_PORT: "5432",
				REGION: "us-east-1",
				S3_PROTOCOL_ACCESS_KEY_ID: S3_LOCAL.id,
				S3_PROTOCOL_ACCESS_KEY_SECRET: S3_LOCAL.secret,
				FUNCTIONS_VERIFY_JWT: "false",
			},
			container,
			run,
			compose,
			servicesStopped: async () => undefined,
			servicesStarted: async () => undefined,
		};
		const source = {
			target: target as never,
			publicUrl: null,
			inputs: { stopWriters: true },
		};
		const parts = ["database", "storage", "functions"];

		// 2. Preflight: empty cloud, nothing blocks; what will not carry over.
		const preflight = await supabaseDriver.preflight(provider, config, {
			direction: "export",
			parts,
			target: { serverName: "smoke", freeDiskBytes: 50 * 1024 ** 3, version: null },
			source,
		});
		console.info("preflight", JSON.stringify(preflight));
		expect(preflight.blockers).toEqual([]);
		expect(preflight.versions).toEqual({ source: "17.6.1.136", target: "17" });
		expect(preflight.warnings.map((warning) => warning.code)).toEqual(
			expect.arrayContaining([
				"CLOUD_WARN_EXPORT_VAULT",
				"CLOUD_WARN_ROLE_PASSWORDS",
				"CLOUD_WARN_EXPORT_FUNCTION_SECRETS",
				"CLOUD_WARN_EXPORT_FUNCTIONS_NO_JWT",
				"CLOUD_WARN_EXPORT_WRITERS_STOPPED",
			]),
		);
		expect(
			preflight.contents.find((row) => row.part === "storage")?.counts,
		).toEqual([
			{ unit: "objects", count: 2 },
			{ unit: "buckets", count: 1 },
		]);
		expect(preflight.contents.find((row) => row.part === "functions")?.names).toEqual(
			["hello"],
		);

		// 3. The job: emptiness checked again, then the steps.
		const opened = await supabaseDriver.open(provider, config, "export", source);
		await opened.assertEmpty?.();
		await opened.prepare(parts);
		const events: { code: string; params: unknown }[] = [];
		const logs: string[] = [];
		const job = {
			deploymentId: "smoke",
			event: (code: string, params?: Record<string, unknown>) =>
				events.push({
					code,
					params: params && redactCodedParams(params as never, redact),
				}),
			log: (output: string) => logs.push(redact(output)),
			addWarnings: async () => undefined,
			critical: async <T>(_step: string, step: () => Promise<T>) => step(),
		};
		const summary: Record<string, unknown> & { warnings: unknown[] } = {
			warnings: [],
		};
		for (const step of opened.steps(parts)) {
			const started = Date.now();
			await step.run({
				job: job as never,
				target: target as never,
				parts,
				summary: summary as never,
				warn: async (warning) => {
					summary.warnings.push(warning);
				},
			});
			console.info(`step ${step.id}: ${Date.now() - started} ms`);
		}
		console.info("events", JSON.stringify(events, null, 1));
		console.info("summary", JSON.stringify(summary, null, 1));

		// Only expected SQL errors (platform-owned objects) while loading.
		expect(events.find((event) => event.code === "cloud_sync.loaded")).toEqual({
			code: "cloud_sync.loaded",
			params: { errors: 0 },
		});
		// Writers stopped before the copy and started after it.
		expect(composeCalls).toEqual(["stop rest", "up rest"]);
		// Database: every table matches, triggers did not re-fire, RLS and
		// the custom role arrived.
		const tables = summary.tables as {
			table: string;
			source: number;
			target: number;
		}[];
		expect(tables.length).toBeGreaterThanOrEqual(5);
		expect(tables.filter((row) => row.source !== row.target)).toEqual([]);
		expect(tables).toContainEqual({ table: "auth.users", source: 3, target: 3 });
		expect(sql(`${P}-cloud`, "select count(*) from public.todos")).toBe("25");
		expect(
			sql(`${P}-cloud`, "select count(*) from public.todos where title like '%!'"),
		).toBe("0");
		expect(
			sql(`${P}-cloud`, "select count(*) from pg_policies where policyname = 'read todos'"),
		).toBe("1");
		expect(
			sql(`${P}-cloud`, "select count(*) from pg_roles where rolname = 'reporting'"),
		).toBe("1");
		// Vault secrets are not copied (the cloud keeps its own key).
		expect(sql(`${P}-cloud`, "select count(*) from vault.secrets")).toBe("0");
		// Storage: rows came with the data, files uploaded, owners kept,
		// the staging schema gone.
		expect(summary.buckets).toEqual([{ bucket: "avatars", source: 2, target: 2 }]);
		const listing = docker([
			...rclone(`http://${P}-s3cloud:9000`, S3_CLOUD),
			"lsf",
			"-R",
			"s:avatars",
		]);
		expect(listing.split("\n").sort()).toEqual(["a.txt", "dir/", "dir/b.txt"]);
		expect(
			sql(
				`${P}-cloud`,
				"select count(*) from storage.objects where name = 'a.txt' and owner is not null",
			),
		).toBe("1");
		expect(
			sql(
				`${P}-cloud`,
				"select count(*) from pg_namespace where starts_with(nspname, '_nitrobase_export')",
			),
		).toBe("0");
		// Functions: deployed with the CLI layout, shared folder and bytes.
		expect(summary.functions).toEqual([{ slug: "hello", ok: true }]);
		const hello = deployed.get("hello");
		expect(hello?.metadata).toMatchObject({
			entrypoint_path: "supabase/functions/hello/index.ts",
			verify_jwt: false,
		});
		expect([...(hello?.files.keys() ?? [])].sort()).toEqual([
			"supabase/functions/_shared/greet.ts",
			"supabase/functions/hello/index.ts",
			"supabase/functions/hello/mod.wasm",
		]);
		expect(
			Buffer.compare(
				hello?.files.get("supabase/functions/hello/mod.wasm") ?? Buffer.alloc(0),
				WASM,
			),
		).toBe(0);
		expect(deployed.has("main")).toBe(false);
		// Each client container saw only its own end's credentials.
		const dumpPass = readFileSync(`${workDir}/secrets/pgpass`, "utf8");
		const loadPass = readFileSync(`${workDir}/secrets-load/pgpass`, "utf8");
		expect(dumpPass).toContain(LOCAL_PW);
		expect(dumpPass).not.toContain(CLOUD_PW);
		expect(loadPass).toContain(CLOUD_PW);
		expect(loadPass).not.toContain(LOCAL_PW);
		// No secret reached the log, the events or the summary.
		const everything = JSON.stringify({ events, logs, summary });
		for (const secret of secrets) {
			expect(everything.includes(secret), "secret leaked").toBe(false);
		}
		expect(
			(summary.notes as { code: string }[]).map((note) => note.code),
		).toEqual(["CLOUD_NOTE_EXPORT_SUPABASE_NEXT"]);

		// Crash recovery while files uploaded: the owners snapshot is put back
		// and dropped (ids and column names in the job state only).
		sql(
			`${P}-cloud`,
			"create schema _nitrobase_export_crashed authorization postgres; create table _nitrobase_export_crashed.objects as select id, owner from storage.objects; alter table _nitrobase_export_crashed.objects owner to postgres; update storage.objects set owner = null",
		);
		await supabaseDriver.recover?.({
			state: {
				kind: "supabase_export_owners",
				columns: ["owner"],
				schema: "_nitrobase_export_crashed",
			},
			target: target as never,
			connection: { provider, config },
		});
		expect(
			sql(
				`${P}-cloud`,
				"select count(*) from storage.objects where name = 'a.txt' and owner is not null",
			),
		).toBe("1");
		expect(
			sql(
				`${P}-cloud`,
				"select count(*) from pg_namespace where starts_with(nspname, '_nitrobase_export')",
			),
		).toBe("0");

		// The app may not hold schemas named like the staging prefix.
		sql(`${P}-db`, "create schema _nitrobase_export_mine");
		const taken = await supabaseDriver.preflight(provider, config, {
			direction: "export",
			parts,
			target: { serverName: "smoke", freeDiskBytes: 50 * 1024 ** 3, version: null },
			source,
		});
		expect(taken.blockers.map((blocker) => blocker.code)).toContain(
			"CLOUD_EXPORT_STAGING_SCHEMA_TAKEN",
		);
		sql(`${P}-db`, "drop schema _nitrobase_export_mine");

		// 4. The project now holds data: preflight and job both refuse.
		const again = await supabaseDriver.preflight(provider, config, {
			direction: "export",
			parts,
			target: { serverName: "smoke", freeDiskBytes: 50 * 1024 ** 3, version: null },
			source,
		});
		expect(again.blockers.map((blocker) => blocker.code)).toContain(
			"CLOUD_EXPORT_NOT_EMPTY",
		);
		const reopened = await supabaseDriver.open(provider, config, "export", source);
		await expect(reopened.assertEmpty?.()).rejects.toMatchObject({
			code: "CLOUD_EXPORT_NOT_EMPTY",
		});
		expect(apiCalls).toContain(
			`POST /v1/projects/${REF}/functions/deploy?slug=hello`,
		);
		await executor.exec(`rm -rf -- '${workDir}'`);
	});
});
