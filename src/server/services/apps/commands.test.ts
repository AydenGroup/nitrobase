import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	appContainerCheckScript,
	appDataBindDirs,
	appDataDirsScript,
	appEnvProbeScript,
	assertAppLocation,
	BIND_FILE_MISSING_EXIT,
	bindSourcesCheckScript,
	chmodExecutableCommand,
	composeConfigCommand,
	composeDownCommand,
	composeLifecycleCommand,
	composeLogsCommand,
	composePrepareCommand,
	composeRecreateServiceCommand,
	composeServiceCommand,
	composeStartServicesCommand,
	composeStatusCommand,
	composeUpCommand,
	connectNetworkCommand,
	containerShellCommand,
	emptyDirsAtFilesScript,
	httpProbeCommand,
	isHealthyStatus,
	orphanScanScript,
	parseAppEnvProbe,
	parseBindFileMissing,
	parseBindFileWarnings,
	parseImageList,
	parseOrphanScan,
	parseServiceStatus,
	projectImagesCommand,
	removeAppFolderCommand,
	removeFileCommand,
	removeImagesScript,
	resolvedBindSources,
} from "./commands";
import { attachNetworksScript } from "./networks";
import { evaluatePreflight } from "./preflight";

const loc = {
	folder: "pocketbase-1a2b3c4d",
	appRoot: "/etc/nitrobase/apps/pocketbase-1a2b3c4d",
	appId: "1a2b3c4d-0000-4000-8000-000000000001",
};
const base =
	"cd '/etc/nitrobase/apps/pocketbase-1a2b3c4d' && docker compose -p 'pocketbase-1a2b3c4d' --project-directory . -f docker-compose.yml --env-file .env";

describe("compose commands", () => {
	it("builds exact, quoted commands", () => {
		expect(composeConfigCommand(loc)).toBe(`${base} config --format json`);
		const attach = attachNetworksScript(loc);
		// Created, attached to the shared networks, then started (BUG-006).
		expect(composeUpCommand(loc)).toBe(
			[
				`${base} up --no-start --remove-orphans --no-build`,
				attach,
				`${base} up -d --remove-orphans --no-build`,
			].join(" &&\n"),
		);
		expect(composeServiceCommand(loc, "restart")).toBe(
			`${attach} &&\n${base} restart`,
		);
		expect(composeServiceCommand(loc, "start", "db")).toBe(
			`${attach} &&\n${base} start 'db'`,
		);
		expect(composeServiceCommand(loc, "stop", "db")).toBe(`${base} stop 'db'`);
		expect(composeStartServicesCommand(loc, ["db", "web"])).toBe(
			`${attach} &&\n${base} start 'db' 'web'`,
		);
		// A forced recreate happens in the first phase only (the second
		// would recreate the attached container again).
		expect(composeRecreateServiceCommand(loc, "web")).toBe(
			[
				`${base} up --no-start --no-deps --no-build --force-recreate 'web'`,
				attach,
				`${base} up -d --no-deps --no-build 'web'`,
			].join(" &&\n"),
		);
		// Callers quoting every word (cloud sync) get the same phases.
		expect(
			composeLifecycleCommand(loc, ["'up'", "'-d'", "'--wait'", "'db'"]),
		).toBe(
			[
				`${base} up --no-start 'db'`,
				attach,
				`${base} up '-d' '--wait' 'db'`,
			].join(" &&\n"),
		);
		expect(composeLifecycleCommand(loc, ["create", "--no-build"])).toBe(
			`${base} create --no-build &&\n${attach}`,
		);
		expect(composeLifecycleCommand(loc, ["logs"])).toBe(`${base} logs`);
		expect(composeDownCommand(loc, false)).toBe(
			"docker compose -p 'pocketbase-1a2b3c4d' down --remove-orphans",
		);
		expect(composeDownCommand(loc, true)).toBe(
			"docker compose -p 'pocketbase-1a2b3c4d' down --remove-orphans --volumes",
		);
		expect(
			composeLogsCommand(loc, { service: "kong", tail: 200, follow: true }),
		).toBe(
			`${base} logs --no-color --timestamps --no-log-prefix --tail 200 --follow 'kong'`,
		);
		expect(
			composeLogsCommand(loc, {
				service: "kong",
				tail: 10,
				follow: false,
				timestamps: false,
			}),
		).toBe(`${base} logs --no-color --no-log-prefix --tail 10 'kong'`);
		expect(composeLogsCommand(loc, { tail: 50.7, follow: false })).toBe(
			`${base} logs --no-color --timestamps --tail 50`,
		);
		expect(composeStatusCommand(loc)).toBe(
			[
				`ids=$(${base} ps --all -q) || exit $?`,
				'[ -n "$ids" ] || exit 0',
				`docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}\t{{.State.Status}}\t{{.State.ExitCode}}\t{{.RestartCount}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}' $ids 2>/dev/null`,
				"exit 0",
			].join("\n"),
		);
		expect(removeAppFolderCommand(loc)).toBe(
			"rm -rf -- '/etc/nitrobase/apps/pocketbase-1a2b3c4d'",
		);
		expect(removeFileCommand("/etc/nitrobase/traefik/dynamic/app-x.yml")).toBe(
			"rm -f -- '/etc/nitrobase/traefik/dynamic/app-x.yml'",
		);
	});

	it("retries pull/build", () => {
		const script = composePrepareCommand(loc, 3);
		expect(script).toContain("for attempt in $(seq 1 3); do");
		expect(script).toContain(
			`${base} pull --ignore-buildable --quiet && ${base} build --pull`,
		);
		expect(script.trim().endsWith("exit 1")).toBe(true);
	});

	it("rejects injected service names and bad locations", () => {
		expect(() => composeServiceCommand(loc, "stop", "db; rm -rf /")).toThrow();
		expect(() => composeStartServicesCommand(loc, ["db", "$(id)"])).toThrow();
		expect(() =>
			composeLogsCommand(loc, { service: "$(id)", tail: 1, follow: false }),
		).toThrow();
		expect(() =>
			assertAppLocation(
				{ folder: "x", appRoot: "/etc/nitrobase/apps/y" },
				"/etc/nitrobase/apps",
			),
		).toThrow();
		expect(() =>
			assertAppLocation(
				{ folder: "../etc", appRoot: "/etc/nitrobase/etc" },
				"/etc/nitrobase/apps",
			),
		).toThrow();
		expect(assertAppLocation(loc, "/etc/nitrobase/apps")).toBe(loc);
	});

	it("builds the health probe and container shell", () => {
		expect(
			httpProbeCommand({
				network: "nitrobase-network",
				image: "curlimages/curl:8.16.0",
				container: "pocketbase-1a2b3c4d-pocketbase",
				port: 8090,
				path: "/api/health",
			}),
		).toBe(
			"docker run --rm --network 'nitrobase-network' 'curlimages/curl:8.16.0' -s -o /dev/null -w '%{http_code}' --max-time 5 'http://pocketbase-1a2b3c4d-pocketbase:8090/api/health'",
		);
		expect(() =>
			httpProbeCommand({
				network: "n",
				image: "i",
				container: "c",
				port: 1,
				path: "/'$(id)'",
			}),
		).toThrow();
		expect(containerShellCommand("app-1-web", true)).toBe(
			"docker exec -it 'app-1-web' sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'",
		);
		expect(containerShellCommand("app-1-web", false)).toContain(
			"docker exec -i ",
		);
		expect(() => containerShellCommand("x; reboot", true)).toThrow();
	});

	it("chmods executable files inside the app folder", () => {
		expect(chmodExecutableCommand(loc, [])).toBeNull();
		expect(
			chmodExecutableCommand(loc, ["volumes/api/kong-entrypoint.sh"]),
		).toBe(
			"chmod 0755 -- '/etc/nitrobase/apps/pocketbase-1a2b3c4d/volumes/api/kong-entrypoint.sh'",
		);
	});
});

describe("bind source check", () => {
	it("checks only sources inside the app folder, deduplicated", () => {
		const script = bindSourcesCheckScript(loc, [
			"/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data",
			"/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data",
			"/srv/media",
		]);
		expect(script.split("\n")).toEqual([
			"set -e",
			`[ "$(realpath -m -- '/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data')" = '/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data' ] || { echo "Bind source is a symlink: "'/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data' >&2; exit 98; }`,
			"[ -e '/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data' ] || mkdir -p -- '/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data'",
			`[ "$(realpath -e -- '/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data')" = '/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data' ] || { echo "Bind source is a symlink: "'/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data' >&2; exit 98; }`,
		]);
	});

	it("requires file binds to be files instead of creating them", () => {
		const script = bindSourcesCheckScript(
			loc,
			[
				"/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data",
				"/etc/nitrobase/apps/pocketbase-1a2b3c4d/init.sh",
			],
			{ files: ["/etc/nitrobase/apps/pocketbase-1a2b3c4d/init.sh"] },
		);
		expect(script).toContain(
			"[ -f '/etc/nitrobase/apps/pocketbase-1a2b3c4d/init.sh' ] || { echo 'bind-file-missing=''/etc/nitrobase/apps/pocketbase-1a2b3c4d/init.sh' >&2; exit 97; }",
		);
		expect(script).not.toContain(
			"mkdir -p -- '/etc/nitrobase/apps/pocketbase-1a2b3c4d/init.sh'",
		);
		expect(script).toContain(
			"mkdir -p -- '/etc/nitrobase/apps/pocketbase-1a2b3c4d/pb_data'",
		);
		expect(BIND_FILE_MISSING_EXIT).toBe(97);
		expect(
			parseBindFileMissing("noise\nbind-file-missing=/a/b/init.sh\n"),
		).toBe("/a/b/init.sh");
		expect(parseBindFileMissing("Bind source is a symlink: /a")).toBeNull();
	});

	it("runs in sh: an empty folder Docker left where a file goes (appwrite 2.4.0)", () => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "bf-agent-bind-")),
		);
		try {
			// `realpath -m/-e` stub (GNU options; macOS's realpath lacks -m).
			const bin = path.join(root, "bin");
			mkdirSync(bin);
			writeFileSync(
				path.join(bin, "realpath"),
				`#!/bin/sh\nmode=$1; shift; [ "$1" = "--" ] && shift\nexec "${process.execPath}" -e 'const fs=require("fs"),p=require("path");const [m,f]=process.argv.slice(-2);try{console.log(fs.realpathSync(f))}catch{if(m==="-e")process.exit(1);console.log(p.resolve(f))}' -- "$mode" "$1"\n`,
				{ mode: 0o755 },
			);
			const app = {
				folder: "appwrite-ad07dc68",
				appRoot: path.join(root, "app"),
			};
			const init = path.join(app.appRoot, "clickhouse-init.sh");
			const data = path.join(app.appRoot, "volumes", "db", "data");
			mkdirSync(init, { recursive: true });
			const sh = (script: string) => {
				try {
					return {
						code: 0,
						out: execFileSync("sh", ["-c", script], {
							encoding: "utf8",
							stdio: ["ignore", "pipe", "pipe"],
							env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
						}),
					};
				} catch (error) {
					const failed = error as { status: number; stderr: string };
					return { code: failed.status, out: failed.stderr };
				}
			};
			// The folder Docker created is refused (pre-up and post-up check).
			const check = bindSourcesCheckScript(app, [init, data], {
				files: [init],
			});
			const refused = sh(check);
			expect(refused.code).toBe(97);
			expect(parseBindFileMissing(refused.out)).toBe(init);
			// Before the files are written, the empty folder is removed...
			expect(
				sh(emptyDirsAtFilesScript(app, ["clickhouse-init.sh", "mongo-init.js"]))
					.out,
			).toBe(`replaced=${init}\n`);
			expect(existsSync(init)).toBe(false);
			// ...so the file can be written, and the check passes; the data
			// folder is created empty as before.
			writeFileSync(init, "#!/bin/bash\n");
			expect(sh(check).code).toBe(0);
			expect(statSync(data).isDirectory()).toBe(true);
			// A non-empty folder is never removed.
			const conf = path.join(app.appRoot, "conf.xml");
			mkdirSync(conf);
			writeFileSync(path.join(conf, "keep"), "x");
			expect(sh(emptyDirsAtFilesScript(app, ["conf.xml"])).out).toBe("");
			expect(existsSync(path.join(conf, "keep"))).toBe(true);

			// A file-named source nothing writes (custom compose ./config.json):
			// before `up` only a warning, never created...
			const config = path.join(app.appRoot, "config.json");
			const named = { namedFiles: [config] };
			const before = sh(bindSourcesCheckScript(app, [config], named));
			expect(before.code).toBe(0);
			expect(parseBindFileWarnings(before.out)).toEqual([config]);
			expect(existsSync(config)).toBe(false);
			// ...after `up`, the empty folder Docker created is refused...
			mkdirSync(config);
			const after = bindSourcesCheckScript(app, [config], {
				...named,
				after: true,
			});
			const failed = sh(after);
			expect(failed.code).toBe(97);
			expect(parseBindFileMissing(failed.out)).toBe(config);
			// ...a folder the app filled is data, and a real file passes.
			writeFileSync(path.join(config, "state"), "x");
			expect(sh(after).code).toBe(0);
			rmSync(config, { recursive: true });
			writeFileSync(config, "{}");
			const ok = sh(bindSourcesCheckScript(app, [config], named));
			expect(ok.code).toBe(0);
			expect(parseBindFileWarnings(ok.out)).toEqual([]);
			expect(sh(after).code).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("extracts bind sources from resolved compose", () => {
		expect(
			resolvedBindSources({
				services: {
					a: {
						volumes: [
							{ type: "bind", source: "/x" },
							{ type: "volume", source: "v" },
						],
					},
					b: {},
				},
			}),
		).toEqual(["/x"]);
	});
});

describe("readiness status", () => {
	it("parses inspect lines (exit code, restarts, health)", () => {
		const statuses = parseServiceStatus(
			[
				"web\trunning\t0\t0\thealthy",
				"db\trunning\t0\t2\t",
				"migrate\texited\t1\t0\t",
				// A container without the compose label, or a broken line.
				"<no value>\trunning\t0\t0\t",
				"",
			].join("\n"),
		);
		expect(statuses).toEqual([
			{
				service: "web",
				state: "running",
				health: "healthy",
				exitCode: 0,
				restarts: 0,
			},
			{ service: "db", state: "running", health: "", exitCode: 0, restarts: 2 },
			{
				service: "migrate",
				state: "exited",
				health: "",
				exitCode: 1,
				restarts: 0,
			},
		]);
		expect(parseServiceStatus("web\trunning")).toEqual([
			{
				service: "web",
				state: "running",
				health: "",
				exitCode: null,
				restarts: null,
			},
		]);
	});
});

describe("orphan scan", () => {
	const me = "instance-me";
	it("groups folders, containers and volumes of unknown apps", () => {
		const output = [
			"folder pocketbase-1a2b3c4d instance-me",
			`folder supabase-deadbeef ${me}`,
			"folder random-folder -",
			`project supabase-deadbeef exited ${me}`,
			`project supabase-deadbeef exited ${me}`,
			"project ",
			"volume supabase-deadbeef supabase-deadbeef_db-config",
			"volume  some-unlabelled-volume",
		].join("\n");
		expect(
			parseOrphanScan(output, new Set(["pocketbase-1a2b3c4d"]), me),
		).toEqual([
			{
				folder: "supabase-deadbeef",
				hasFolder: true,
				containers: 2,
				running: 0,
				volumes: ["supabase-deadbeef_db-config"],
				owner: "self",
				wipeable: true,
			},
		]);
	});

	it("never offers to wipe foreign, unowned or running data", () => {
		const output = [
			"folder pocketbase-11111111 other-instance",
			"project pocketbase-11111111 running other-instance",
			"folder pocketbase-22222222 -",
			"volume pocketbase-22222222 pocketbase-22222222_data",
			`folder pocketbase-33333333 ${me}`,
			`project pocketbase-33333333 running ${me}`,
			// Mixed owners (folder ours, container someone else's): foreign.
			`folder pocketbase-44444444 ${me}`,
			"project pocketbase-44444444 exited other-instance",
			// Garbage owner values are ignored.
			"folder pocketbase-55555555 $(rm -rf /)",
		].join("\n");
		const byFolder = Object.fromEntries(
			parseOrphanScan(output, new Set(), me).map((entry) => [
				entry.folder,
				[entry.owner, entry.wipeable, entry.running],
			]),
		);
		expect(byFolder).toEqual({
			"pocketbase-11111111": ["foreign", false, 1],
			"pocketbase-22222222": ["unknown", false, 0],
			"pocketbase-33333333": ["self", false, 1],
			"pocketbase-44444444": ["foreign", false, 0],
			"pocketbase-55555555": ["unknown", false, 0],
		});
		// Without a known instance id nothing is ever wipeable.
		expect(
			parseOrphanScan(output, new Set(), null).some((entry) => entry.wipeable),
		).toBe(false);
	});

	it("only scans resources Nitrobase labelled", () => {
		const script = orphanScanScript("/etc/nitrobase/apps");
		const labelled = '{{if .Label "nitrobase.app"}}';
		expect(script).toContain(`docker ps -a --format '${labelled}`);
		expect(script).toContain(`docker volume ls --format '${labelled}`);
		// `.Labels` is a string for ps/volume ls: `index` would fail silently.
		expect(script).not.toContain("index .Labels");
		expect(script).toContain('(or (.Label "nitrobase.instance") "-")');
		expect(script).toContain('"$d.nitrobase-instance"');
	});

	it("reads app folder markers", () => {
		const root = mkdtempSync(path.join(tmpdir(), "fx-agent-orphan-"));
		try {
			const bin = path.join(root, "bin");
			mkdirSync(bin);
			// Stub `docker` printing nothing (no daemon is touched).
			writeFileSync(path.join(bin, "docker"), "#!/bin/sh\ntrue\n", {
				mode: 0o755,
			});
			const apps = path.join(root, "apps");
			mkdirSync(path.join(apps, "a-1111aaaa"), { recursive: true });
			mkdirSync(path.join(apps, "b-2222bbbb"));
			mkdirSync(path.join(apps, "c-3333cccc"));
			writeFileSync(
				path.join(apps, "a-1111aaaa", ".nitrobase-instance"),
				"old\n",
			);
			writeFileSync(
				path.join(apps, "b-2222bbbb", ".nitrobase-instance"),
				"new\n",
			);
			const out = execFileSync("sh", ["-c", orphanScanScript(apps)], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
			});
			expect(out.split("\n").filter(Boolean)).toEqual([
				"folder a-1111aaaa old",
				"folder b-2222bbbb new",
				"folder c-3333cccc -",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("checks the app label before exec'ing into a container", () => {
		const script = appContainerCheckScript(
			["pocketbase-1a2b3c4d-web"],
			"app-1",
		);
		expect(script).toContain(
			`docker inspect -f '{{index .Config.Labels "nitrobase.app"}}' 'pocketbase-1a2b3c4d-web'`,
		);
		expect(script).toContain(`[ "$l" = 'app-1' ]`);
		expect(() => appContainerCheckScript(["x; rm"], "app-1")).toThrow();
		expect(
			containerShellCommand("pocketbase-1a2b3c4d-web", true, "app-1"),
		).toMatch(/^if l=.*; fi; true; docker exec -it/);
	});

	it("builds an idempotent network attach", () => {
		expect(connectNetworkCommand("nitrobase-network", "nitrobase_app")).toBe(
			"docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' 'nitrobase-network' | grep -qw 'nitrobase_app' || docker network connect 'nitrobase-network' 'nitrobase_app'",
		);
	});
});

describe("preflight evaluation", () => {
	it("compares free resources with requirements", () => {
		const checks = evaluatePreflight(
			{
				mem_kb: String(512 * 1024),
				disk_kb: String(500 * 1024),
				docker: "29.0.0",
				traefik: "true",
			},
			{ memoryMb: 1024, diskMb: 1024 },
		);
		expect(Object.fromEntries(checks.map((c) => [c.id, c.status]))).toEqual({
			docker: "ok",
			traefik: "ok",
			memory: "warning",
			disk: "error",
		});
		// Raw bytes go to the client, which formats them in the viewer's locale.
		expect(checks.find((c) => c.id === "memory")?.message).toEqual({
			code: "memory",
			params: {
				availableBytes: 512 * 1024 * 1024,
				recommendedBytes: 1024 ** 3,
			},
		});
		const down = evaluatePreflight(
			{ docker: "", traefik: "" },
			{ memoryMb: 0, diskMb: 0 },
		);
		expect(down.find((c) => c.id === "docker")?.status).toBe("error");
		expect(down.find((c) => c.id === "traefik")?.status).toBe("error");
	});

	it("checks the template's minimum Docker version", () => {
		const docker = (version: string, min: string) =>
			evaluatePreflight(
				{ docker: version, traefik: "true" },
				{ memoryMb: 0, diskMb: 0, minDockerVersion: min },
			).find((c) => c.id === "docker")?.status;
		expect(docker("24.0.7", "24.0")).toBe("ok");
		expect(docker("29.8.2", "24.0")).toBe("ok");
		expect(docker("20.10.24", "24.0")).toBe("error");
		expect(docker("24.0.0-rc.1", "24")).toBe("ok");
	});
});

describe("isHealthyStatus", () => {
	it("accepts < 500 by default and only listed statuses when declared", () => {
		expect(isHealthyStatus(401)).toBe(true);
		expect(isHealthyStatus(503)).toBe(false);
		expect(isHealthyStatus(0)).toBe(false);
		expect(isHealthyStatus(401, [200, 401])).toBe(true);
		expect(isHealthyStatus(404, [200, 401])).toBe(false);
	});
});

describe("image cleanup", () => {
	it("lists the project's images and removes them without force", () => {
		expect(projectImagesCommand("supabase-0123abcd")).toBe(
			"docker ps -a --filter 'label=com.docker.compose.project=supabase-0123abcd' --format '{{.Image}}' | sort -u",
		);
		expect(
			parseImageList(
				"kong:3.9\nsupabase/gotrue:v2\n\nbad image;rm\nkong:3.9\n",
			),
		).toEqual(["kong:3.9", "supabase/gotrue:v2"]);
		expect(removeImagesScript(["kong:3.9", "x;rm -rf /"])).toBe(
			`docker image rm -- 'kong:3.9' >/dev/null 2>&1 && echo "Removed image kong:3.9" || echo "Kept image kong:3.9 (still in use)"`,
		);
		expect(removeImagesScript([])).toBeNull();
	});
});

describe("existing app state probe", () => {
	it("reads the .env only from a folder this instance owns", () => {
		const script = appEnvProbeScript(loc, "inst-1");
		expect(script).toContain(`[ "$o" = 'inst-1' ]`);
		expect(script).toContain(
			"base64 < '/etc/nitrobase/apps/pocketbase-1a2b3c4d/.env'",
		);
		expect(script).toContain(
			"label=com.docker.compose.project=pocketbase-1a2b3c4d",
		);
		expect(() => appEnvProbeScript(loc, "x'; rm -rf /")).toThrow();
	});

	it("parses the probe output", () => {
		const env = Buffer.from("A='1'\n").toString("base64");
		expect(parseAppEnvProbe(`owner=inst-1\nenv=${env}\nvolumes=2\n`)).toEqual({
			owner: "inst-1",
			envText: "A='1'\n",
			volumes: 2,
		});
		expect(parseAppEnvProbe("owner=-\nenv=-\nvolumes=0\n")).toEqual({
			owner: null,
			envText: null,
			volumes: 0,
		});
	});

	it("runs in sh: owned folder, foreign folder, data folders", () => {
		const root = mkdtempSync(path.join(tmpdir(), "fx-agent-probe-"));
		try {
			// A stub `docker` (no daemon is touched): two project volumes.
			const bin = path.join(root, "bin");
			mkdirSync(bin);
			writeFileSync(path.join(bin, "docker"), "#!/bin/sh\necho v1\necho v2\n", {
				mode: 0o755,
			});
			const app = { folder: "demo-1234abcd", appRoot: path.join(root, "app") };
			mkdirSync(path.join(app.appRoot, "data"), { recursive: true });
			mkdirSync(path.join(app.appRoot, "empty"));
			writeFileSync(path.join(app.appRoot, "data", "PG_VERSION"), "17\n");
			const env = "A='x y'\nB=\"it's \\$z\"\n";
			writeFileSync(path.join(app.appRoot, ".env"), env);
			writeFileSync(path.join(app.appRoot, ".nitrobase-instance"), "inst-1\n");
			const sh = (script: string) =>
				execFileSync("sh", ["-c", script], {
					encoding: "utf8",
					env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
				});
			expect(parseAppEnvProbe(sh(appEnvProbeScript(app, "inst-1")))).toEqual({
				owner: "inst-1",
				envText: env,
				volumes: 2,
			});
			expect(
				parseAppEnvProbe(sh(appEnvProbeScript(app, "other"))).envText,
			).toBeNull();
			expect(
				sh(
					appDataDirsScript([
						path.join(app.appRoot, "data"),
						path.join(app.appRoot, "empty"),
						path.join(app.appRoot, "missing"),
					]),
				).trim(),
			).toBe("data=1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lists data bind folders, not rendered config", () => {
		const root = loc.appRoot;
		expect(
			appDataBindDirs(
				loc,
				{
					services: {
						db: {
							volumes: [
								"./volumes/db/data:/var/lib/postgresql/data:Z",
								`${root}/volumes/db/init.sql:/init.sql`,
								{ type: "bind", source: `${root}/volumes/functions` },
								{ type: "volume", source: "db-config" },
								"/srv/outside:/x",
								"$" + "{DATA}:/y",
							],
						},
					},
				},
				["volumes/db/init.sql", "volumes/functions/main/index.ts"],
			),
		).toEqual([`${root}/volumes/db/data`]);
		expect(appDataDirsScript([`${root}/data`])).toContain(
			`ls -A -- '${root}/data'`,
		);
	});
});
