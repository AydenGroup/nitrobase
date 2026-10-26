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
 * Smoke test of the Supabase import driver against a fake cloud, on this
 * machine's Docker (see vitest.config.ts):
 * - cs-agent-cloud-db: supabase/postgres seeded like a hosted project
 *   (tables, a trigger, RLS, auth users, storage rows, a Vault secret, a
 *   custom role, a function calling the cloud domain);
 * - cs-agent-s3cloud: an S3 server with the bucket's files;
 * - a mock Management API (this process, 127.0.0.1:3102): project, session
 *   pooler, pgsodium root key, functions list and multipart sources;
 * - the "new app": cs-agent-db (same image, fresh), cs-agent-s3local (its
 *   storage S3 endpoint), cs-agent-functions (the edge functions folder).
 * The driver's own test, preflight and import steps run through a
 * SyncTarget on the local executor; the app deploy and job bookkeeping
 * are not part of it. Everything is removed afterwards.
 */

const PG_IMAGE = "supabase/postgres:17.6.1.136";
const S3_IMAGE = "rustfs/rustfs:1.0.1";
const FUNCTIONS_IMAGE = "debian:stable-slim";
const RCLONE_IMAGE = "rclone/rclone:1.71.1";
/** Name prefix of everything the smoke creates (vitest.config.ts). */
const P = process.env.SMOKE_PREFIX ?? "cs-agent";
const PORT = Number(process.env.SMOKE_API_PORT ?? 3102);
const NET = `${P}-net`;
const ROOT = `/private/tmp/${P}-smoke`;
const REF = "smokeprojectrefabcde";
const TOKEN = "sbp_smoke_token_0123456789";
const CLOUD_PW = "cloud-db-password-123";
const LOCAL_PW = "local-db-password-456";
const S3_CLOUD = { id: "cloudaccesskey", secret: "cloud-s3-secret-789" };
const S3_LOCAL = { id: "localaccesskey", secret: "local-s3-secret-012" };
const CONTAINERS = [
	`${P}-cloud-db`,
	`${P}-db`,
	`${P}-s3cloud`,
	`${P}-s3local`,
	`${P}-functions`,
];

function docker(args: string[], input?: string, timeout = 180_000): string {
	const result = spawnSync("docker", args, {
		input,
		encoding: "utf8",
		timeout,
	});
	if (result.status !== 0) {
		throw new Error(
			`docker ${args.slice(0, 3).join(" ")} failed: ${result.stderr || result.error}`,
		);
	}
	return result.stdout.trim();
}

async function waitPostgres(container: string) {
	for (let i = 0; i < 120; i++) {
		const ok = spawnSync(
			"docker",
			["exec", container, "pg_isready", "-h", "localhost", "-q"],
			{ timeout: 10_000 },
		);
		if (ok.status === 0) {
			// The image's init scripts restart the server once.
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
 * What the storage service's migrations create in a real project (the bare
 * database image has no storage tables): applied to both databases, like
 * the new app's storage container does before the import loads data.
 */
const STORAGE_SCHEMA = `
create schema if not exists storage;
create table if not exists storage.migrations (id integer primary key, name text, hash text, executed_at timestamptz default now());
create table if not exists storage.buckets (id text primary key, name text not null, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
  name text, owner uuid, metadata jsonb, version text, created_at timestamptz default now(), updated_at timestamptz default now(),
  last_accessed_at timestamptz default now());
insert into storage.migrations (id, name, hash) values (0, 'create-migrations-table', 'x') on conflict do nothing;
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
create function public.call_cloud() returns text language sql as $$ select 'https://${REF}.supabase.co/functions/v1/hello' $$;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    'u' || g || '@example.com', extensions.crypt('pw', extensions.gen_salt('bf')), now(), now()
  from generate_series(1, 3) g;
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
insert into storage.objects (bucket_id, name, metadata) values
  ('avatars', 'a.txt', '{"size": 5}'), ('avatars', 'dir/b.txt', '{"size": 6}');
select vault.create_secret('s3cret-value', 'api_key');
create role reporting login password 'reportpw';
grant select on public.todos to reporting;
`;

const BOUNDARY = "smokeBoundary42";
function functionBody(): Buffer {
	const part = (headers: string[], body: string) =>
		`--${BOUNDARY}\r\n${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
	const text = Buffer.from(
		[
			part(
				['Content-Disposition: form-data; name="metadata"'],
				JSON.stringify({
					deno2_entrypoint_path: "file:///tmp/fn/source/index.ts",
				}),
			),
			part(
				[
					'Content-Disposition: form-data; name="file"; filename="/tmp/fn/source/index.ts"',
				],
				'import { greet } from "../_shared/greet.ts";\nDeno.serve(() => new Response(greet()));\n',
			),
			part(
				[
					'Content-Disposition: form-data; name="file"; filename="/tmp/fn/_shared/greet.ts"',
				],
				'export const greet = () => "hello";\n',
			),
			part(
				[
					'Content-Disposition: form-data; name="file"; filename="/tmp/fn/source/../../../etc/evil"',
				],
				"nope",
			),
		].join(""),
	);
	// A binary file (wasm header + bytes that are not UTF-8) at the end.
	return Buffer.concat([
		text,
		Buffer.from(
			`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="/tmp/fn/source/mod.wasm"\r\nContent-Type: application/wasm\r\n\r\n`,
		),
		WASM,
		Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
	]);
}

const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0xff, 0x80, 0xfe]);

let server: http.Server;
let cloudDbIp = "";
let rootKey = "";
const apiCalls: string[] = [];

function startMockApi(): Promise<void> {
	server = http.createServer((request, response) => {
		apiCalls.push(`${request.method} ${request.url}`);
		if (request.headers.authorization !== `Bearer ${TOKEN}`) {
			response.writeHead(401).end('{"message":"unauthorized"}');
			return;
		}
		const json = (value: unknown) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(value));
		};
		const base = `/v1/projects/${REF}`;
		switch (request.url) {
			case base:
				return json({
					ref: REF,
					name: "Smoke project",
					region: "us-east-1",
					status: "ACTIVE_HEALTHY",
					database: { host: `db.${REF}.supabase.co`, version: "17.6.1.136" },
				});
			case `${base}/config/database/pooler`:
				return json([
					{
						database_type: "PRIMARY",
						pool_mode: "transaction",
						db_host: cloudDbIp,
						db_port: 6543,
						db_user: "supabase_admin",
						db_name: "postgres",
					},
					{
						database_type: "PRIMARY",
						pool_mode: "session",
						db_host: cloudDbIp,
						db_port: 5432,
						db_user: "supabase_admin",
						db_name: "postgres",
					},
				]);
			case `${base}/pgsodium`:
				return json({ root_key: rootKey });
			case `${base}/functions`:
				return json([
					{
						id: "1",
						slug: "hello",
						name: "hello",
						status: "ACTIVE",
						version: 3,
						verify_jwt: false,
						entrypoint_path: "file:///tmp/fn/source/index.ts",
					},
				]);
			case `${base}/functions/hello/body`:
				response.writeHead(200, {
					"content-type": `multipart/form-data; boundary=${BOUNDARY}`,
				});
				response.end(functionBody());
				return;
			default:
				response.writeHead(404).end("{}");
		}
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
	pg(`${P}-cloud-db`, CLOUD_PW);
	pg(`${P}-db`, LOCAL_PW);
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
		FUNCTIONS_IMAGE,
		"sh",
		"-c",
		"mkdir -p /home/deno/functions/main && exec sleep 100000",
	]);
	await waitPostgres(`${P}-cloud-db`);
	await waitPostgres(`${P}-db`);
	sql(`${P}-cloud-db`, STORAGE_SCHEMA);
	sql(`${P}-db`, STORAGE_SCHEMA);
	sql(`${P}-cloud-db`, SEED);
	rootKey = docker([
		"exec",
		`${P}-cloud-db`,
		"cat",
		"/etc/postgresql-custom/pgsodium_root.key",
	]);
	cloudDbIp = ip(`${P}-cloud-db`);
	const s3CloudIp = ip(`${P}-s3cloud`);
	await sleep(3000);
	const cloudS3 = rclone(`http://${P}-s3cloud:9000`, S3_CLOUD);
	docker([...cloudS3, "mkdir", "s:avatars"]);
	docker([...cloudS3, "rcat", "s:avatars/a.txt"], "hello");
	docker([...cloudS3, "rcat", "s:avatars/dir/b.txt"], "world!");
	docker([...rclone(`http://${P}-s3local:9000`, S3_LOCAL), "mkdir", "s:avatars"]);
	process.env.CLOUD_SYNC_SUPABASE_S3_URL = `http://${s3CloudIp}:9000`;
	process.env.CLOUD_SYNC_EXTRA_ALLOWED_HOSTS = `127.0.0.1,${cloudDbIp},${s3CloudIp}`;
	await startMockApi();
});

afterAll(async () => {
	if (server) await new Promise((resolve) => server.close(resolve));
	cleanup();
});

describe("Supabase import against a fake cloud", () => {
	it("tests, previews and imports database, storage and functions", async () => {
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

		const provider = getCloudSyncProvider("supabase");
		if (!provider) throw new Error("no provider");
		const config = {
			projectRef: REF,
			accessToken: TOKEN,
			dbPassword: CLOUD_PW,
			s3AccessKeyId: S3_CLOUD.id,
			s3SecretAccessKey: S3_CLOUD.secret,
		};

		// 1. Connection test: API, pooler query, S3 ListBuckets (SigV4).
		const test = await supabaseDriver.test(provider, config);
		console.info("test", JSON.stringify(test));
		expect(test.steps.map((step) => [step.step, step.ok])).toEqual([
			["api", true],
			["database", true],
			["storage", true],
		]);
		expect(test.info.buckets).toBe("1");

		// 2. Preflight.
		const preflight = await supabaseDriver.preflight(provider, config, {
			direction: "import",
			parts: ["database", "storage", "functions"],
			target: {
				serverName: "smoke",
				freeDiskBytes: 50 * 1024 ** 3,
				version: "17",
			},
		});
		console.info("preflight", JSON.stringify(preflight));
		expect(preflight.blockers).toEqual([]);
		const warnings = preflight.warnings.map((warning) => warning.code);
		expect(warnings).toEqual(
			expect.arrayContaining([
				"CLOUD_WARN_VAULT_KEY_COPIED",
				"CLOUD_WARN_ROLE_PASSWORDS",
				"CLOUD_WARN_CLOUD_REFERENCES",
				"CLOUD_WARN_FUNCTION_SECRETS",
				"CLOUD_WARN_FUNCTIONS_VERIFY_JWT",
			]),
		);
		expect(
			preflight.contents.find((row) => row.part === "storage")?.counts,
		).toEqual([
			{ unit: "objects", count: 2 },
			{ unit: "buckets", count: 1 },
		]);
		expect(
			analyzeBlocker(
				await supabaseDriver.preflight(provider, config, {
					direction: "import",
					parts: ["database"],
					target: { serverName: "smoke", freeDiskBytes: 10, version: "15" },
				}),
			),
		).toEqual(["CLOUD_SYNC_VERSION_DOWNGRADE", "CLOUD_SYNC_DISK_LOW"]);

		// 3. Import steps on the "new app".
		const opened = await supabaseDriver.open(provider, config, "import");
		await opened.prepare(["database", "storage", "functions"]);
		const secrets = [
			TOKEN,
			CLOUD_PW,
			LOCAL_PW,
			S3_CLOUD.secret,
			S3_LOCAL.secret,
			...opened.secrets(),
		];
		const redact = redactor(secrets);
		const events: { code: string; params: unknown }[] = [];
		const logs: string[] = [];
		let warningCount = 0;
		const job = {
			deploymentId: "smoke",
			event: (code: string, params?: Record<string, unknown>) =>
				events.push({
					code,
					params: params && redactCodedParams(params as never, redact),
				}),
			log: (output: string) => logs.push(redact(output)),
			addWarnings: async (count: number) => {
				warningCount += count;
			},
			critical: async <T>(_step: string, step: () => Promise<T>) => step(),
			servicesStopped: async () => undefined,
			servicesStarted: async () => undefined,
		};
		// Managed file writes are Linux scripts (GNU realpath/mv): on a macOS
		// dev host the smoke writes the staging files with node instead.
		const local = new LocalExecutor();
		const executor = {
			kind: "local" as const,
			exec: local.exec.bind(local),
			shell: local.shell.bind(local),
			close: () => undefined,
			upload: async (content: string | Buffer, path: string, mode = "0644") => {
				mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
				writeFileSync(path, content, { mode: Number.parseInt(mode, 8) });
				chmodSync(path, Number.parseInt(mode, 8));
			},
			readFile: async (path: string) => readFileSync(path, "utf8"),
		};
		const workDir = `${hostPaths().backupWork}/cloud-import-smoke`;
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
		const compose = async (args: string[], failure: unknown) => {
			const [verb, ...rest] = args.filter((arg) => !arg.startsWith("-"));
			const names = rest.map(container);
			const dockerVerb = verb === "up" ? "start" : verb;
			const out = await run(`docker ${dockerVerb} ${names.join(" ")}`, failure);
			if (names.includes(`${P}-db`)) await waitPostgres(`${P}-db`);
			return out;
		};
		const pluginConfig = {
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
			sync_writer_services: ["functions"],
			db_port_variable: "POSTGRES_PORT",
			storage_s3_path: "/",
			storage_region: "REGION",
			storage_s3_key_id: "S3_PROTOCOL_ACCESS_KEY_ID",
			storage_s3_key_secret: "S3_PROTOCOL_ACCESS_KEY_SECRET",
			db_root_key_file: "/etc/postgresql-custom/pgsodium_root.key",
			db_root_key_owner: "postgres",
		};
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
			},
			container,
			run,
			compose,
			servicesStopped: async () => undefined,
			servicesStarted: async () => undefined,
		};
		const summary: Record<string, unknown> & { warnings: unknown[] } = {
			warnings: [],
		};
		const warn = async (warning: { code: string | null }) => {
			job.event("job.warning", { warning: { $error: warning } });
			warningCount += 1;
			summary.warnings.push(warning);
		};
		for (const step of opened.steps(["database", "storage", "functions"])) {
			const started = Date.now();
			await step.run({
				job: job as never,
				target: target as never,
				parts: ["database", "storage", "functions"],
				summary: summary as never,
				warn: warn as never,
			});
			console.info(`step ${step.id}: ${Date.now() - started} ms`);
		}
		console.info("events", JSON.stringify(events, null, 1));
		console.info("summary", JSON.stringify(summary, null, 1));

		// Database: every compared table matches, triggers did not re-fire,
		// the Vault secret decrypts with the copied key, the custom role exists.
		const tables = summary.tables as {
			table: string;
			source: number;
			target: number;
		}[];
		expect(tables.length).toBeGreaterThanOrEqual(5);
		expect(tables.filter((row) => row.source !== row.target)).toEqual([]);
		expect(tables).toContainEqual({
			table: "auth.users",
			source: 3,
			target: 3,
		});
		expect(sql(`${P}-db`, "select count(*) from public.todos where title like '%!'")).toBe("0");
		expect(
			sql(
				`${P}-db`,
				"select decrypted_secret from vault.decrypted_secrets where name = 'api_key'",
			),
		).toBe("s3cret-value");
		expect(
			sql(`${P}-db`, "select count(*) from pg_roles where rolname = 'reporting'"),
		).toBe("1");
		expect(
			sql(`${P}-db`, "select count(*) from pg_policies where policyname = 'read todos'"),
		).toBe("1");

		// Storage: both files copied into the local S3 endpoint.
		expect(summary.buckets).toEqual([
			{ bucket: "avatars", source: 2, target: 2 },
		]);
		const listing = docker([
			...rclone(`http://${P}-s3local:9000`, S3_LOCAL),
			"lsf",
			"-R",
			"s:avatars",
		]);
		expect(listing.split("\n").sort()).toEqual(["a.txt", "dir/", "dir/b.txt"]);

		// Edge functions: sources written, the shared folder next to them,
		// the path escaping the folder skipped.
		expect(summary.functions).toEqual([{ slug: "hello", ok: true }]);
		const wasm = spawnSync(
			"docker",
			["exec", `${P}-functions`, "cat", "/home/deno/functions/hello/mod.wasm"],
			{ timeout: 30_000 },
		).stdout;
		expect(Buffer.compare(wasm, WASM)).toBe(0);
		// The load container's credentials hold the app database only.
		const loadPass = readFileSync(`${workDir}/secrets-load/pgpass`, "utf8");
		expect(loadPass).toContain(LOCAL_PW);
		expect(loadPass).not.toContain(CLOUD_PW);
		expect(readFileSync(`${workDir}/secrets/pgpass`, "utf8")).not.toContain(
			LOCAL_PW,
		);
		expect(
			docker([
				"exec",
				`${P}-functions`,
				"cat",
				"/home/deno/functions/hello/index.ts",
			]),
		).toContain("../_shared/greet.ts");
		expect(
			docker([
				"exec",
				`${P}-functions`,
				"cat",
				"/home/deno/functions/_shared/greet.ts",
			]),
		).toContain("hello");
		expect(
			spawnSync("docker", ["exec", `${P}-functions`, "test", "-e", "/etc/evil"])
				.status,
		).not.toBe(0);
		expect(summary.warnings.map((w) => (w as { code: string }).code)).toContain(
			"CLOUD_WARN_FUNCTION_FILES_SKIPPED",
		);

		// No secret reached the log, the events or the summary.
		const everything = JSON.stringify({ events, logs, summary });
		for (const secret of secrets) {
			expect(everything.includes(secret), "secret leaked").toBe(false);
		}
		expect(apiCalls).toContain(`GET /v1/projects/${REF}/pgsodium`);
		expect(warningCount).toBeGreaterThan(0);
		await executor.exec(`rm -rf -- '${workDir}'`);
	});
});

function analyzeBlocker(result: { blockers: { code: string | null }[] }) {
	return result.blockers.map((blocker) => blocker.code);
}
