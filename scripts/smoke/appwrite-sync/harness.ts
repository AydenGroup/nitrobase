import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { sleep } from "#/libs/async.ts";

/**
 * Shared by the Appwrite smokes (import.smoke.ts, export.smoke.ts): apps
 * rendered from templates/appwrite on this machine's Docker, a REST
 * client, and the seeding of a project like a used cloud one.
 */

/** Name prefix of everything the smokes create (vitest.config.ts). */
export const P = process.env.SMOKE_PREFIX ?? "aw-agent";
export const NET = `${P}-net`;
export const ROOT = `/private/tmp/${P}-smoke`;
export const VERSION = "2.3.0";
export const PROJECT = "smokeproj";
export const EMAIL = "owner@aw-agent.test";
export const USERS = [
	{ id: "alice", email: "alice@aw-agent.test", password: "alice-pass-123456" },
	{ id: "bob", email: "bob@aw-agent.test", password: "bob-pass-123456" },
];
/** Text plus binary bytes (a NUL and 0xff) that must arrive unchanged. */
export const FILE_BYTES = Buffer.concat([
	Buffer.from("hello from the cloud bucket\n"),
	Buffer.from([0x00, 0xff]),
]);
export const KEEP = process.env.AW_SMOKE_KEEP === "1";
/** Optional services the import does not need (lighter smoke). */
export const DROP = ["appwrite-browser", "appwrite-console", "appwrite-autogravity"];

export function sh(
	command: string,
	args: string[],
	options: { input?: string | Buffer; timeout?: number; cwd?: string } = {},
) {
	const result = spawnSync(command, args, {
		input: options.input,
		cwd: options.cwd,
		timeout: options.timeout ?? 600_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.slice(0, 4).join(" ")} failed: ${result.stderr?.toString() || result.error}`,
		);
	}
	return result.stdout.toString().trim();
}

export const docker = (args: string[], timeout?: number) =>
	sh("docker", args, { timeout });

export interface App {
	name: string;
	folder: string;
	dir: string;
	values: Record<string, string>;
	plugin: unknown;
}

const upstream = path.resolve(
	"src/server/services/templates/__fixtures__/templates/appwrite/upstream",
);

export function readTree(dir: string) {
	const out: { path: string; content: Buffer; executable: boolean }[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			const rel = path.relative(dir, full).split(path.sep).join("/");
			if (entry.isDirectory()) walk(full);
			else {
				out.push({
					path: rel,
					content: readFileSync(full),
					executable: (statSync(full).mode & 0o111) !== 0,
				});
			}
		}
	};
	walk(dir);
	return out;
}

/** Render templates/appwrite as `name` and start it (compose project = folder). */
export async function startApp(
	name: string,
	appId: string,
	options: { workerOnProxy: boolean; overrides?: Record<string, string> },
): Promise<App> {
	const { TemplateManifestSchema } = await import(
		"#/features/templates/schema.ts"
	);
	const { includedPaths, renderFromFiles } = await import(
		"#/server/services/templates/render.ts"
	);
	const { PROXY_NETWORK_KEY } = await import(
		"#/server/services/templates/compose-policy.ts"
	);
	const manifest = TemplateManifestSchema.parse(
		parseToml(readFileSync("templates/appwrite/template.toml", "utf8")),
	);
	manifest.id = name;
	const include = includedPaths(manifest.source.include, VERSION);
	const files = readTree(upstream).filter((file) =>
		include.includes(file.path),
	);
	const rendered = renderFromFiles(
		{
			manifest,
			files,
			overlay: readFileSync("templates/appwrite/overlay.yml", "utf8"),
			version: VERSION,
			commitSha: "0".repeat(40),
			appId,
			appName: name,
			// What `driver.importInputs` gives `createAppRecord` (editable).
			overrides: options.overrides,
			domain: `${name}.test`,
		},
		{
			appsRoot: ROOT,
			traefikDynamicDir: `${ROOT}/traefik`,
			network: NET,
			certResolver: "smoke",
			hasher: (password) => bcrypt.hashSync(password, 4),
		},
	);
	const dir = rendered.appRoot;
	const saved = path.join(dir, "values.json");
	if (KEEP && existsSync(saved)) {
		// A kept app from an earlier run: same secrets, already running.
		return {
			name,
			folder: rendered.folder,
			dir,
			values: JSON.parse(readFileSync(saved, "utf8")),
			plugin: manifest.plugin,
		};
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(saved, JSON.stringify(rendered.values), { mode: 0o600 });
	for (const file of rendered.files) {
		const target = path.join(dir, file.path);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, file.content, {
			mode: file.executable ? 0o755 : 0o644,
		});
	}
	const model = parseYaml(rendered.compose) as {
		services: Record<
			string,
			{ depends_on?: unknown; networks?: Record<string, unknown> }
		>;
	};
	for (const service of DROP) delete model.services[service];
	for (const service of Object.values(model.services)) {
		if (Array.isArray(service.depends_on)) {
			service.depends_on = service.depends_on.filter(
				(dep) => !DROP.includes(String(dep)),
			);
		}
	}
	if (options.workerOnProxy) {
		const worker = model.services["appwrite-worker"];
		worker.networks = {
			...(worker.networks ?? {}),
			[PROXY_NETWORK_KEY]: {},
		};
	}
	writeFileSync(path.join(dir, "docker-compose.yml"), stringifyYaml(model));
	writeFileSync(path.join(dir, ".env"), rendered.envFile, { mode: 0o600 });
	sh(
		"docker",
		["compose", "-p", rendered.folder, "--project-directory", dir, "up", "-d"],
		{ timeout: 40 * 60_000 },
	);
	return {
		name,
		folder: rendered.folder,
		dir,
		values: rendered.values,
		plugin: manifest.plugin,
	};
}

export function stopApp(app: App) {
	spawnSync(
		"docker",
		[
			"compose",
			"-p",
			app.folder,
			"--project-directory",
			app.dir,
			"down",
			"-v",
			"--remove-orphans",
		],
		{ timeout: 600_000 },
	);
}

export const ipOf = (container: string) =>
	docker([
		"inspect",
		"-f",
		`{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`,
		container,
	]);

export async function waitHealthy(base: string) {
	for (let i = 0; i < 600; i++) {
		try {
			const response = await fetch(`${base}/health/version`, {
				headers: { "X-Appwrite-Project": "console" },
			});
			if (response.ok) return;
		} catch {
			// starting
		}
		await sleep(2000);
	}
	throw new Error(`${base} did not become healthy`);
}

/** A small REST client for the "cloud" (seeding) and checks on the new app. */
export function client(base: string) {
	return async (
		method: string,
		pathName: string,
		headers: Record<string, string>,
		body?: unknown,
	) => {
		const isForm = body instanceof FormData;
		const response = await fetch(`${base}${pathName}`, {
			method,
			headers: {
				...headers,
				...(body !== undefined && !isForm
					? { "Content-Type": "application/json" }
					: {}),
			},
			body:
				body === undefined
					? undefined
					: isForm
						? (body as FormData)
						: JSON.stringify(body),
		});
		const text = await response.text();
		let json: unknown = null;
		try {
			json = JSON.parse(text);
		} catch {
			json = null;
		}
		return { status: response.status, headers: response.headers, text, json };
	};
}

/** The console admin a seeded "cloud" signs up with (smoke-only values). */
export const CLOUD_ADMIN = {
	email: "cloud-admin@aw-agent.test",
	password: "cloud-admin-pass-123",
};

export async function seedCloud(
	base: string,
	admin: { email: string; password: string } = CLOUD_ADMIN,
) {
	const call = client(base);
	const ok = async (
		...args: Parameters<ReturnType<typeof client>>
	): Promise<Record<string, unknown>> => {
		const result = await call(...args);
		// 409: seeded by an earlier run of a kept app.
		if (result.status >= 300 && result.status !== 409) {
			throw new Error(`${args[0]} ${args[1]}: ${result.status} ${result.text}`);
		}
		return (result.json ?? {}) as Record<string, unknown>;
	};
	const consoleHeaders = { "X-Appwrite-Project": "console" };
	await call("POST", "/account", consoleHeaders, {
		userId: "unique()",
		email: admin.email,
		password: admin.password,
		name: "cloud admin",
	});
	const session = await call("POST", "/account/sessions/email", consoleHeaders, {
		email: admin.email,
		password: admin.password,
	});
	const cookie = (session.headers.getSetCookie?.() ?? [])
		.map((value) => value.split(";")[0])
		.find((value) => value.startsWith("a_session_console="));
	if (!cookie) throw new Error(`no console session: ${session.text}`);
	const auth = { ...consoleHeaders, Cookie: cookie };
	// Self-hosted Appwrite allows one organization: reuse it on a re-run.
	const teams = await ok("GET", "/teams", auth);
	const team =
		(teams.teams as Record<string, unknown>[] | undefined)?.[0] ??
		(await ok("POST", "/teams", auth, {
			teamId: "unique()",
			name: "Cloud org",
		}));
	const existing = await call("GET", `/projects/${PROJECT}`, auth);
	if (existing.status === 404) {
		await ok("POST", "/projects", auth, {
			projectId: PROJECT,
			name: "Smoke Project",
			teamId: team.$id,
		});
	}
	const key = await ok("POST", `/projects/${PROJECT}/keys`, auth, {
		keyId: "unique()",
		name: "cloud-export",
		scopes: [
			"users.read",
			"users.write",
			"teams.read",
			"teams.write",
			"databases.read",
			"databases.write",
			"tables.read",
			"tables.write",
			"columns.read",
			"columns.write",
			"indexes.read",
			"indexes.write",
			"rows.read",
			"rows.write",
			"collections.read",
			"attributes.read",
			"documents.read",
			"buckets.read",
			"buckets.write",
			"files.read",
			"files.write",
			"functions.read",
			"functions.write",
			"execution.read",
			"platforms.read",
			"platforms.write",
			"project.read",
			"policies.read",
			"project.policies.read",
			"project.oauth2.read",
			"templates.read",
			"keys.read",
			"webhooks.read",
			"providers.read",
			"topics.read",
			"subscribers.read",
			"messages.read",
			"sites.read",
			"rules.read",
			"health.read",
		],
	});
	const secret = String(key.secret);
	const p = { "X-Appwrite-Project": PROJECT, "X-Appwrite-Key": secret };
	for (const user of USERS) {
		await ok("POST", "/users", p, {
			userId: user.id,
			email: user.email,
			password: user.password,
			name: user.id,
		});
	}
	await ok("POST", "/teams", p, { teamId: "crew", name: "Crew" });
	await ok("POST", "/teams/crew/memberships", p, {
		userId: "alice",
		roles: ["member"],
	});
	await ok("POST", "/tablesdb", p, { databaseId: "shop", name: "Shop" });
	for (const table of ["products", "orders"]) {
		await ok("POST", "/tablesdb/shop/tables", p, {
			tableId: table,
			name: table,
			permissions: ['read("any")'],
		});
		await ok("POST", `/tablesdb/shop/tables/${table}/columns/string`, p, {
			key: "name",
			size: 64,
			required: true,
		});
	}
	for (let i = 0; i < 60; i++) {
		const columns = await ok("GET", "/tablesdb/shop/tables/products/columns", p);
		const orders = await ok("GET", "/tablesdb/shop/tables/orders/columns", p);
		const ready = [columns, orders].every((list) =>
			(list.columns as { status: string }[]).every(
				(column) => column.status === "available",
			),
		);
		if (ready) break;
		await sleep(1000);
	}
	for (const [table, rows] of [
		["products", ["pen", "ink", "paper"]],
		["orders", ["o-1", "o-2"]],
	] as const) {
		for (const name of rows) {
			await ok("POST", `/tablesdb/shop/tables/${table}/rows`, p, {
				rowId: name.replace(/[^a-z0-9]/g, ""),
				data: { name },
			});
		}
	}
	await ok("POST", "/storage/buckets", p, {
		bucketId: "media",
		name: "Media",
		permissions: ['read("any")'],
		fileSecurity: false,
	});
	const form = new FormData();
	form.append("fileId", "hello");
	form.append("file", new Blob([FILE_BYTES]), "hello.bin");
	await ok("POST", "/storage/buckets/media/files", p, form);
	await ok("POST", "/functions", p, {
		functionId: "hello",
		name: "Hello",
		runtime: "node-22",
		entrypoint: "index.js",
	});
	await ok("POST", "/functions/hello/variables", p, {
		variableId: "greeting",
		key: "GREETING",
		value: "hi",
	});
	await ok("POST", "/project/platforms/web", p, {
		platformId: "web",
		name: "Web",
		hostname: "app.aw-agent.test",
	});
	return { secret };
}

