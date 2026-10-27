import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, RELEASE_REPO_DEFAULT } from "#/config/shared.ts";

// Each case runs bash with a few dozen subprocesses.
vi.setConfig({ testTimeout: 60_000 });

/**
 * scripts/install.sh runs for real under bash, with the system commands it
 * calls (id, uname, df, ss, docker, curl, apt-get…) replaced by mocks that
 * log their arguments. Nothing outside a temp folder is touched.
 */
const SCRIPT = path.resolve(__dirname, "../../../../scripts/install.sh");
const COMPOSE = path.resolve(__dirname, "../../../../docker-compose.prod.yml");

let root: string;
let bin: string;
let callLog: string;

function mock(name: string, body: string): void {
	const file = path.join(bin, name);
	writeFileSync(file, `#!/bin/bash\n${body}\n`);
	chmodSync(file, 0o755);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "sb-install-"));
	bin = path.join(root, "bin");
	mkdirSync(bin);
	callLog = path.join(root, "calls.log");
	writeFileSync(callLog, "");
	writeFileSync(
		path.join(root, "os-release"),
		'ID=debian\nVERSION_CODENAME=bookworm\nPRETTY_NAME="Debian 12"\n',
	);
	writeFileSync(path.join(root, "meminfo"), "MemTotal:        4000000 kB\n");
	const log = `echo "$(basename "$0") $*" >> ${JSON.stringify(callLog)}`;
	mock("id", `${log}\necho "\${MOCK_UID:-0}"`);
	mock("uname", 'echo "${MOCK_ARCH:-x86_64}"');
	mock(
		"df",
		'echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "/dev/x 100000000 1 ${MOCK_DISK_KB:-90000000} 1% /"',
	);
	mock("ss", "exit 0");
	mock("hostname", 'echo "203.0.113.7"');
	mock("sleep", "exit 0");
	mock("apt-get", `${log}\nexit 0`);
	mockCurl();
	mock(
		"docker",
		[
			log,
			'case "$*" in',
			'  "compose version") exit 0;;',
			'  version*) [ -z "$MOCK_NO_DAEMON" ] || exit 1; echo 27.3.1;;',
			// The installer container's own mounts ("source|destination" lines).
			'  "inspect --type container -f"*Mounts*) [ -n "$MOCK_MOUNTS" ] || exit 1; printf "%b\\n" "$MOCK_MOUNTS";;',
			'  "inspect -f"*) echo healthy;;',
			'  ps*) [ -z "$MOCK_PS" ] || echo "$MOCK_PS";;',
			"  inspect*) exit 1;;",
			"  *) exit 0;;",
			"esac",
		].join("\n"),
	);
});

/** One releases API answer: HTTP status (0: no connection) and body. */
type Answer = [status: number, body: string];

/**
 * curl: compose files, Docker's key and the releases API. Honors `-o`,
 * `-f` (exit 22 from HTTP 400) and `-w` (the status on a last line).
 */
function mockCurl(api: { latest?: Answer; list?: Answer } = {}): void {
	const latest = api.latest ?? [
		200,
		'{"url":"x","tag_name":"v1.4.2","name":"Nitrobase 1.4.2"}',
	];
	const list = api.list ?? [404, '{"message":"Not Found"}'];
	const answer = ([status, body]: Answer) =>
		status === 0 ? "exit 7" : `answer ${status} '${body}'`;
	mock(
		"curl",
		[
			`echo "$(basename "$0") $*" >> ${JSON.stringify(callLog)}`,
			'out=""; url=""; fmt=""',
			'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -H) shift 2;; -w) fmt="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done',
			'answer() { printf "%s" "$2"; if [ -n "$fmt" ]; then printf "\\n%s" "$1"; elif [ "$1" -ge 400 ]; then exit 22; fi; }',
			'case "$url" in',
			`  *docker-compose.prod.yml) cp ${JSON.stringify(COMPOSE)} "$out";;`,
			'  */gpg) echo "-----BEGIN PGP PUBLIC KEY BLOCK-----" > "$out";;',
			`  */releases/latest) ${answer(latest)};;`,
			`  */releases\\?per_page=*) ${answer(list)};;`,
			"  *) exit 22;;",
			"esac",
		].join("\n"),
	);
}

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * PATH of the mocks plus the system tools, minus `hidden`: a host that has
 * the real tool (CI runners ship Docker in /usr/bin) still runs the
 * "missing" branch.
 */
function pathWithout(...hidden: string[]): string {
	const system = path.join(root, "system-bin");
	mkdirSync(system, { recursive: true });
	for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			const link = path.join(system, name);
			if (hidden.some((tool) => name.startsWith(tool)) || existsSync(link)) {
				continue;
			}
			symlinkSync(path.join(dir, name), link);
		}
	}
	return `${bin}:${system}`;
}

function run(args: string[], env: Record<string, string> = {}) {
	const result = spawnSync("bash", [SCRIPT, ...args], {
		encoding: "utf8",
		env: {
			PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
			HOME: root,
			NITROBASE_OS_RELEASE: path.join(root, "os-release"),
			NITROBASE_MEMINFO: path.join(root, "meminfo"),
			NITROBASE_INSTALL_PARENT: path.join(root, "opt"),
			...env,
		} as unknown as NodeJS.ProcessEnv,
	});
	return {
		code: result.status,
		out: result.stdout,
		err: result.stderr,
		calls: readFileSync(callLog, "utf8"),
	};
}

function config(
	args: string[],
	env: Record<string, string> = {},
): Record<string, string> {
	const result = run([...args, "--print-config"], env);
	expect(result.err).toBe("");
	expect(result.code).toBe(0);
	return Object.fromEntries(
		result.out
			.trim()
			.split("\n")
			.map((line) => [
				line.slice(0, line.indexOf("=")),
				line.slice(line.indexOf("=") + 1),
			]),
	);
}

const dir = () => path.join(root, "opt", "nitrobase");

function envOf(folder = dir()): Record<string, string> {
	return Object.fromEntries(
		readFileSync(path.join(folder, ".env"), "utf8")
			.trim()
			.split("\n")
			.map((line) => [
				line.slice(0, line.indexOf("=")),
				line.slice(line.indexOf("=") + 1),
			]),
	);
}

describe("installer arguments", () => {
	it("has safe defaults", () => {
		expect(config(["--repo", "Acme/Nitrobase"])).toMatchObject({
			dir: dir(),
			version: "latest",
			panel_bind: "0.0.0.0:3000",
			domain: "",
			image: "ghcr.io/acme/nitrobase",
			api_url: "https://api.github.com",
			raw_url: "https://raw.githubusercontent.com/Acme/Nitrobase",
			uninstall: "0",
		});
	});

	it("installs the official releases without --repo", () => {
		expect(config([])).toMatchObject({
			repo: RELEASE_REPO_DEFAULT,
			image: `ghcr.io/${RELEASE_REPO_DEFAULT.toLowerCase()}`,
			raw_url: `https://raw.githubusercontent.com/${RELEASE_REPO_DEFAULT}`,
		});
		expect(config([], { NITROBASE_REPO: "Me/Fork" }).image).toBe(
			"ghcr.io/me/fork",
		);
	});

	it("reads every option", () => {
		expect(
			config([
				"--version",
				"v2.0.1",
				"--dir",
				"/srv/sb",
				"--domain",
				"Panel.Example.com",
				"--image",
				"registry.example.com/me/nitrobase",
				"--api-url",
				"https://git.example.com/api/v1/",
				"--raw-url",
				"https://git.example.com/me/nitrobase/raw/tag",
			]),
		).toMatchObject({
			version: "2.0.1",
			dir: "/srv/sb",
			domain: "panel.example.com",
			// Behind a panel domain, plain HTTP stays on the loopback.
			panel_bind: "127.0.0.1:3000",
			image: "registry.example.com/me/nitrobase",
			api_url: "https://git.example.com/api/v1",
		});
		// Pre-release tags (`v0.1.0-beta.0`) are image tags without the "v".
		expect(config(["--version", "v0.1.0-beta.0"]).version).toBe("0.1.0-beta.0");
		expect(
			config(["--domain", "p.example.com", "--panel-bind", "0.0.0.0:8080"])
				.panel_bind,
		).toBe("0.0.0.0:8080");
		expect(config(["--uninstall", "--purge"])).toMatchObject({
			uninstall: "1",
			purge: "1",
		});
	});

	it.each([
		[["--dir", "relative/path"], /absolute/],
		[["--dir", "/"], /cannot be/],
		[["--dir", "/opt/sb;rm"], /may only contain/],
		[["--dir", "/opt/nitrobase/"], /empty path components/],
		[["--dir", "/opt//nitrobase"], /empty path components/],
		[["--dir", "/opt/nitrobase/."], /empty path components/],
		[["--dir", "/opt/./nitrobase"], /empty path components/],
		[["--dir", "/opt/../nitrobase"], /empty path components/],
		[["--dir", "/.."], /empty path components/],
		[["--panel-bind", "3000"], /panel-bind/],
		[["--domain", "not a domain"], /invalid --domain/],
		[["--version", "1.0;reboot"], /invalid version from --version/],
		[["--repo", "no-slash"], /owner\/name/],
		[["--purge"], /only goes with --uninstall/],
		[["--frobnicate"], /unknown option/],
		[["--version"], /needs a value/],
		[["--dir", "--yes"], /needs a value/],
	])("refuses %j", (args, message) => {
		const result = run([...args, "--print-config"]);
		expect(result.code).not.toBe(0);
		expect(result.err).toMatch(message);
	});

	it("prints help", () => {
		const result = run(["--help"]);
		expect(result.code).toBe(0);
		expect(result.out).toMatch(/--panel-bind/);
	});
});

describe("installer run (mocked system)", () => {
	it("refuses to run without root", () => {
		const result = run(base(), { MOCK_UID: "1000" });
		expect(result.code).not.toBe(0);
		expect(result.err).toMatch(/run as root/);
	});

	it("refuses an unsupported OS or CPU", () => {
		writeFileSync(path.join(root, "os-release"), "ID=fedora\n");
		expect(run(base()).err).toMatch(/unsupported OS/);
		writeFileSync(path.join(root, "os-release"), "ID=debian\n");
		expect(run(base(), { MOCK_ARCH: "riscv64" }).err).toMatch(/architecture/);
	});

	it("refuses a nearly full disk, warns on a small one, and --skip-resource-check skips both", () => {
		const full = run(base(), { MOCK_DISK_KB: String(1500 * 1024) });
		expect(full.code).not.toBe(0);
		expect(full.err).toMatch(/only 1500 MB free .*--skip-resource-check/);
		const small = run(base(), { MOCK_DISK_KB: String(4558 * 1024) });
		expect(small.code).toBe(0);
		expect(small.err).toMatch(/warning: only 4558 MB free/);
		writeFileSync(path.join(root, "meminfo"), "MemTotal:        1000000 kB\n");
		const skipped = run([...base(), "--skip-resource-check"], {
			MOCK_DISK_KB: String(1500 * 1024),
		});
		expect(skipped.code).toBe(0);
		expect(skipped.err).not.toMatch(/MB (free|of RAM)/);
	});

	it("installs the latest release with generated secrets that never reach the output", () => {
		const result = run(base());
		expect(result.err).toBe("");
		expect(result.code).toBe(0);
		const env = envOf();
		for (const name of [
			"ENCRYPTION_KEY",
			"SESSION_SECRET",
			"POSTGRES_PASSWORD",
		]) {
			expect(env[name]).toMatch(/^[0-9a-f]{64}$/);
			expect(result.out).not.toContain(env[name]);
		}
		expect(env).toMatchObject({
			NITROBASE_VERSION: "1.4.2",
			NITROBASE_IMAGE: "ghcr.io/acme/nitrobase",
			PANEL_BIND: "0.0.0.0:3000",
			RELEASE_REPO: "acme/nitrobase",
		});
		expect(statSync(path.join(dir(), ".env")).mode & 0o777).toBe(0o600);
		expect(statSync(dir()).mode & 0o777).toBe(0o700);
		expect(
			readFileSync(path.join(dir(), "docker-compose.yml"), "utf8"),
		).toContain("container_name: nitrobase_app");
		expect(result.calls).toMatch(
			/curl .*\/repos\/acme\/nitrobase\/releases\/latest/,
		);
		expect(result.calls).toMatch(
			/curl .*\/v1\.4\.2\/docker-compose\.prod\.yml/,
		);
		expect(result.calls).toMatch(/docker compose .* up -d/);
		expect(result.calls).not.toMatch(/apt-get/);
		expect(result.out).toMatch(/Back up the secrets/);
		expect(result.out).toMatch(/http:\/\/203\.0\.113\.7:3000/);
		// One-time setup token: generated, kept 0600, printed once for step 2.
		expect(env.SETUP_TOKEN).toMatch(/^[0-9a-f]{32}$/);
		expect(result.out).toContain(
			`Setup token (asked once, until the first account exists): ${env.SETUP_TOKEN}`,
		);
	});

	it("is idempotent: a second run keeps the secrets and applies --version", () => {
		expect(run(base()).code).toBe(0);
		const first = envOf();
		const again = run([...base(), "--version", "1.5.0"]);
		expect(again.code).toBe(0);
		const second = envOf();
		expect(second.ENCRYPTION_KEY).toBe(first.ENCRYPTION_KEY);
		expect(second.SESSION_SECRET).toBe(first.SESSION_SECRET);
		expect(second.POSTGRES_PASSWORD).toBe(first.POSTGRES_PASSWORD);
		expect(second.NITROBASE_VERSION).toBe("1.5.0");
		expect(second.SETUP_TOKEN).toBe(first.SETUP_TOKEN);
		// One assignment per key.
		const text = readFileSync(path.join(dir(), ".env"), "utf8");
		expect(text.match(/^ENCRYPTION_KEY=/gm)).toHaveLength(1);
		expect(again.out).not.toMatch(/Back up the secrets/);
		// Without --version the installed one stays.
		expect(run(base()).code).toBe(0);
		expect(envOf().NITROBASE_VERSION).toBe("1.5.0");
	});

	it("validates versions from .env and from the releases API", () => {
		expect(run(base()).code).toBe(0);
		const envFile = path.join(dir(), ".env");
		writeFileSync(
			envFile,
			readFileSync(envFile, "utf8").replace(
				/^NITROBASE_VERSION=.*$/m,
				"NITROBASE_VERSION=1.0;reboot",
			),
		);
		const bad = run(base());
		expect(bad.code).not.toBe(0);
		expect(bad.err).toMatch(/invalid version from .*\.env/);
		rmSync(dir(), { recursive: true, force: true });
		mockCurl({ latest: [200, '{"tag_name":"v1.0 && reboot"}'] });
		const api = run(base());
		expect(api.code).not.toBe(0);
		expect(api.err).toMatch(/invalid version from the latest release/);
	});

	it("installs the newest pre-release while no stable release exists", () => {
		mockCurl({
			latest: [404, '{"message":"Not Found"}'],
			list: [
				200,
				'[{"url":"x","tag_name":"v0.1.0-beta.1","prerelease":true},{"tag_name":"v0.1.0-beta.0"}]',
			],
		});
		const result = run(base());
		expect(result.code).toBe(0);
		expect(result.err).toMatch(/no stable release yet.*v0\.1\.0-beta\.1/);
		expect(envOf()).toMatchObject({
			NITROBASE_VERSION: "0.1.0-beta.1",
			// Offered the next pre-releases in the panel.
			RELEASE_CHANNEL: "prerelease",
		});
		expect(result.calls).toMatch(
			/\/v0\.1\.0-beta\.1\/docker-compose\.prod\.yml/,
		);
		// An explicit channel is kept.
		const envFile = path.join(dir(), ".env");
		writeFileSync(
			envFile,
			readFileSync(envFile, "utf8").replace(
				/^RELEASE_CHANNEL=.*$/m,
				"RELEASE_CHANNEL=stable",
			),
		);
		expect(run(base()).code).toBe(0);
		expect(envOf().RELEASE_CHANNEL).toBe("stable");
	});

	it("keeps the stable channel for a stable release", () => {
		expect(run(base()).code).toBe(0);
		expect(envOf().RELEASE_CHANNEL).toBeUndefined();
	});

	it("drops only a pre-release channel it set itself on a stable install", () => {
		expect(run([...base(), "--version", "0.1.0-beta.0"]).code).toBe(0);
		expect(envOf().RELEASE_CHANNEL).toBe("prerelease");
		expect(run([...base(), "--version", "0.1.0"]).code).toBe(0);
		expect(envOf().RELEASE_CHANNEL).toBeUndefined();
		expect(readFileSync(path.join(dir(), ".env"), "utf8")).not.toMatch(
			/install\.sh/,
		);
		// Chosen by the user: kept on a stable install.
		const envFile = path.join(dir(), ".env");
		writeFileSync(
			envFile,
			`${readFileSync(envFile, "utf8")}RELEASE_CHANNEL=prerelease\n`,
		);
		expect(run([...base(), "--version", "0.2.0"]).code).toBe(0);
		expect(envOf().RELEASE_CHANNEL).toBe("prerelease");
	});

	it("falls back to the release list only when latest is 404", () => {
		mockCurl({
			latest: [500, '{"message":"Server Error"}'],
			list: [200, '[{"tag_name":"v0.1.0-beta.1"}]'],
		});
		const failed = run(base());
		expect(failed.code).not.toBe(0);
		expect(failed.err).toMatch(/could not read the latest release .*HTTP 500/);
		expect(failed.calls).not.toMatch(/per_page/);

		mockCurl({ latest: [0, ""] });
		const offline = run(base());
		expect(offline.code).not.toBe(0);
		expect(offline.err).toMatch(/HTTP 000/);

		mockCurl({
			latest: [404, '{"message":"Not Found"}'],
			list: [200, "[]"],
		});
		const none = run(base());
		expect(none.code).not.toBe(0);
		expect(none.err).toMatch(/has no release yet/);
	});

	it("keeps a custom image and repository on a re-run", () => {
		expect(
			run([...base(), "--image", "registry.example.com/me/nitrobase"]).code,
		).toBe(0);
		expect(run(base()).code).toBe(0);
		expect(envOf().NITROBASE_IMAGE).toBe("registry.example.com/me/nitrobase");

		rmSync(dir(), { recursive: true, force: true });
		const fork = ["--dir", dir(), "--yes"];
		expect(run([...fork, "--repo", "Me/Fork"]).code).toBe(0);
		expect(envOf()).toMatchObject({
			RELEASE_REPO: "Me/Fork",
			NITROBASE_IMAGE: "ghcr.io/me/fork",
		});
		// Re-run without --repo: the fork stays, its releases are read.
		const again = run(fork);
		expect(again.code).toBe(0);
		expect(envOf()).toMatchObject({
			RELEASE_REPO: "Me/Fork",
			NITROBASE_IMAGE: "ghcr.io/me/fork",
		});
		expect(config(["--dir", dir()])).toMatchObject({
			repo: "Me/Fork",
			image: "ghcr.io/me/fork",
			raw_url: "https://raw.githubusercontent.com/Me/Fork",
		});
		// Back to the official releases: RELEASE_REPO goes away.
		expect(run([...fork, "--repo", RELEASE_REPO_DEFAULT]).code).toBe(0);
		expect(envOf().RELEASE_REPO).toBeUndefined();
		expect(envOf().NITROBASE_IMAGE).toBe(
			`ghcr.io/${RELEASE_REPO_DEFAULT.toLowerCase()}`,
		);
	});

	it("never purges a folder that is not a panel install", () => {
		mkdirSync(dir(), { recursive: true });
		writeFileSync(path.join(dir(), "docker-compose.yml"), "services: {}\n");
		writeFileSync(path.join(dir(), "precious.txt"), "keep me");
		const result = run(["--dir", dir(), "--uninstall", "--purge"], {
			NITROBASE_PURGE_CONFIRM: `purge ${dir()}`,
		});
		expect(result.code).not.toBe(0);
		expect(result.err).toMatch(new RegExp(`no ${APP_NAME} install`));
		expect(existsSync(path.join(dir(), "precious.txt"))).toBe(true);
	});

	it("sets up the panel domain", () => {
		const result = run([...base(), "--domain", "panel.example.com"]);
		expect(result.code).toBe(0);
		expect(envOf()).toMatchObject({
			PANEL_DOMAIN: "panel.example.com",
			APP_URL: "https://panel.example.com",
			PANEL_BIND: "127.0.0.1:3000",
			TRUST_PROXY: "true",
		});
		expect(result.out).toMatch(/ssh -L 3000:127\.0\.0\.1:3000/);
		expect(result.out).toMatch(/https:\/\/panel\.example\.com/);
		// An upgrade without the options keeps the panel on the loopback.
		expect(run([...base(), "--version", "1.5.0"]).code).toBe(0);
		expect(envOf().PANEL_BIND).toBe("127.0.0.1:3000");
		expect(run([...base(), "--panel-bind", "0.0.0.0:8080"]).code).toBe(0);
		expect(envOf().PANEL_BIND).toBe("0.0.0.0:8080");
		// --domain again: a public address goes back to the loopback, a
		// loopback port of the user's is kept.
		const domain = [...base(), "--domain", "panel.example.com"];
		expect(run(domain).code).toBe(0);
		expect(envOf().PANEL_BIND).toBe("127.0.0.1:3000");
		expect(run([...base(), "--panel-bind", "127.0.0.1:4000"]).code).toBe(0);
		expect(run(domain).code).toBe(0);
		expect(envOf().PANEL_BIND).toBe("127.0.0.1:4000");
	});

	it("keeps a PANEL_BIND edited by hand and never fails uninstall on it", () => {
		expect(run(base()).code).toBe(0);
		const envFile = path.join(dir(), ".env");
		writeFileSync(
			envFile,
			readFileSync(envFile, "utf8").replace(
				/^PANEL_BIND=.*$/m,
				"PANEL_BIND=localhost:3000",
			),
		);
		const again = run([...base(), "--version", "1.5.0"]);
		expect(again.code).toBe(0);
		expect(again.err).toMatch(/PANEL_BIND=localhost:3000 .* kept as is/);
		expect(envOf().PANEL_BIND).toBe("localhost:3000");
		// A bad --panel-bind is still refused.
		expect(run([...base(), "--panel-bind", "localhost:3000"]).err).toMatch(
			/invalid --panel-bind/,
		);
		const keep = run(["--dir", dir(), "--uninstall"]);
		expect(keep.code).toBe(0);
		expect(keep.err).toBe("");
		const purged = run(["--dir", dir(), "--uninstall", "--purge"], {
			NITROBASE_PURGE_CONFIRM: `purge ${dir()}`,
		});
		expect(purged.code).toBe(0);
		expect(existsSync(dir())).toBe(false);
	});

	it("installs Docker from the official repository when missing", () => {
		rmSync(path.join(bin, "docker"));
		mock("dpkg", "echo amd64");
		const apt = path.join(root, "apt");
		const result = run(base(), {
			NITROBASE_APT_ETC: apt,
			PATH: pathWithout("docker"),
		});
		expect(
			readFileSync(path.join(apt, "sources.list.d/docker.list"), "utf8"),
		).toBe(
			"deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable\n",
		);
		// The mock apt-get cannot really install it: the run stops after.
		expect(result.code).not.toBe(0);
		expect(result.calls).toMatch(
			/apt-get install .*docker-ce .*docker-compose-plugin/,
		);
		expect(result.calls).toMatch(
			/curl .*download\.docker\.com\/linux\/debian\/gpg/,
		);
	});

	it("uninstall keeps data; purge needs the typed confirmation", () => {
		expect(run(base()).code).toBe(0);
		const keep = run(["--dir", dir(), "--uninstall"]);
		expect(keep.code).toBe(0);
		expect(keep.calls).toMatch(
			/--project-name nitrobase .* down --remove-orphans/,
		);
		expect(keep.calls).not.toMatch(/--volumes/);
		expect(existsSync(path.join(dir(), ".env"))).toBe(true);

		const refused = run(["--dir", dir(), "--uninstall", "--purge"], {
			NITROBASE_PURGE_CONFIRM: "yes",
		});
		expect(refused.code).not.toBe(0);
		expect(refused.err).toMatch(/not confirmed/);
		expect(existsSync(path.join(dir(), ".env"))).toBe(true);

		const purged = run(["--dir", dir(), "--uninstall", "--purge"], {
			NITROBASE_PURGE_CONFIRM: `purge ${dir()}`,
		});
		expect(purged.code).toBe(0);
		expect(purged.calls).toMatch(/down --volumes/);
		expect(existsSync(dir())).toBe(false);
	});
});

describe("installer in a container (installer image, mocked system)", () => {
	const SOCKET = "/var/run/docker.sock";

	/** The installer image's environment, with $DIR mounted at the same path. */
	function inContainer(
		env: Record<string, string> = {},
	): Record<string, string> {
		const mountinfo = path.join(root, "mountinfo");
		writeFileSync(
			mountinfo,
			[
				"1 0 0:1 / / rw - overlay overlay rw",
				`2 1 0:2 / ${dir()} rw - ext4 /dev/x rw`,
				`3 1 0:3 /var/lib/docker/containers/${"a".repeat(64)}/hostname /etc/hostname rw - ext4 /dev/x rw`,
				"",
			].join("\n"),
		);
		return {
			NITROBASE_INSTALLER_CONTAINER: "1",
			NITROBASE_MOUNTINFO: mountinfo,
			MOCK_MOUNTS: `${SOCKET}|${SOCKET}\\n${dir()}|${dir()}`,
			...env,
		};
	}

	beforeEach(() => {
		// `docker run -v` creates the folder on both sides.
		mkdirSync(dir(), { recursive: true });
		mock("ss", `echo "ss $*" >> ${JSON.stringify(callLog)}`);
	});

	it("skips the OS check, the Docker install and ss, and prints a host-neutral summary", () => {
		writeFileSync(path.join(root, "os-release"), "ID=alpine\n");
		const result = run(base(), inContainer());
		expect(result.err).toBe("");
		expect(result.code).toBe(0);
		expect(result.calls).not.toMatch(/apt-get/);
		expect(result.calls).not.toMatch(/^ss /m);
		// Busy ports are looked up through the socket.
		expect(result.calls).toMatch(/docker ps --filter publish=3000/);
		expect(result.calls).toMatch(
			/docker compose --project-directory \S+ --project-name nitrobase .* up -d/,
		);
		// Its own container is found from its mounts.
		expect(result.calls).toContain(`docker inspect -f`);
		expect(result.calls).toContain("a".repeat(64));
		const env = envOf();
		expect(env.NITROBASE_VERSION).toBe("1.4.2");
		// The container's address is not the host's.
		expect(result.out).not.toMatch(/203\.0\.113\.7/);
		expect(result.out).toMatch(/http:\/\/<server-ip>:3000/);
		expect(result.out).toMatch(/http:\/\/localhost:3000/);
		expect(result.out).toMatch(/Back up the secrets/);
		expect(result.out).toContain(
			`Setup token (asked once, until the first account exists): ${env.SETUP_TOKEN}`,
		);
		expect(result.out).toContain(
			`docker run --rm -it -v ${SOCKET}:${SOCKET} -v ${dir()}:${dir()} ghcr.io/${RELEASE_REPO_DEFAULT.toLowerCase()}-installer:latest --version <v>`,
		);
	});

	it("needs the Docker socket", () => {
		const result = run(base(), inContainer({ MOCK_NO_DAEMON: "1" }));
		expect(result.code).not.toBe(0);
		expect(result.err).toContain(
			`mount its socket with -v ${SOCKET}:${SOCKET}`,
		);
		expect(result.calls).not.toMatch(/apt-get/);
		expect(existsSync(path.join(dir(), ".env"))).toBe(false);
	});

	it("refuses a missing or mismatched install folder mount with the -v to use", () => {
		const hint = `-v ${dir()}:${dir()}`;
		rmSync(dir(), { recursive: true });
		const missing = run(base(), inContainer());
		expect(missing.code).not.toBe(0);
		expect(missing.err).toContain(
			`is not mounted into the installer: add ${hint}`,
		);

		mkdirSync(dir(), { recursive: true });
		const env = inContainer();
		writeFileSync(
			env.NITROBASE_MOUNTINFO,
			"1 0 0:1 / / rw - overlay overlay rw\n",
		);
		const notMounted = run(base(), env);
		expect(notMounted.code).not.toBe(0);
		expect(notMounted.err).toContain(`is not a mount of the host: add ${hint}`);

		const other = run(
			base(),
			inContainer({
				MOCK_MOUNTS: `${SOCKET}|${SOCKET}\\n/srv/elsewhere|${dir()}`,
			}),
		);
		expect(other.code).not.toBe(0);
		expect(other.err).toContain("mounted from /srv/elsewhere on the host");
		expect(other.err).toContain(hint);
		expect(existsSync(path.join(dir(), ".env"))).toBe(false);

		// Its own container cannot be found (e.g. --hostname): no guess.
		const unknown = inContainer();
		delete unknown.MOCK_MOUNTS;
		const lost = run(base(), unknown);
		expect(lost.code).not.toBe(0);
		expect(lost.err).toContain("do not pass --hostname to docker run");
		expect(lost.err).toContain(hint);
		expect(existsSync(path.join(dir(), ".env"))).toBe(false);

		// A parent folder mounted at the same path holds it as well.
		const parent = path.dirname(dir());
		const viaParent = inContainer({
			MOCK_MOUNTS: `${SOCKET}|${SOCKET}\\n${parent}|${parent}`,
		});
		writeFileSync(
			viaParent.NITROBASE_MOUNTINFO,
			`2 1 0:2 / ${parent} rw - ext4 /dev/x rw\n`,
		);
		expect(run(base(), viaParent).code).toBe(0);
	});

	it("refuses a busy panel port published by another container", () => {
		const result = run(base(), inContainer({ MOCK_PS: "someone_else" }));
		expect(result.code).not.toBe(0);
		expect(result.err).toMatch(/port 3000 is already in use/);
	});

	it("needs root in the container", () => {
		const result = run(base(), inContainer({ MOCK_UID: "1000" }));
		expect(result.code).not.toBe(0);
		expect(result.err).toMatch(/installer image as root \(without --user\)/);
	});

	it("installs the image's own version unless --version or an install says otherwise", () => {
		const pinned = inContainer({
			NITROBASE_INSTALLER_VERSION: "0.1.0-beta.0",
		});
		const fresh = run(base(), pinned);
		expect(fresh.code).toBe(0);
		expect(envOf().NITROBASE_VERSION).toBe("0.1.0-beta.0");
		expect(fresh.calls).not.toMatch(/releases\/latest/);
		expect(fresh.calls).toMatch(
			/\/v0\.1\.0-beta\.0\/docker-compose\.prod\.yml/,
		);

		// --version wins (the upgrade path).
		expect(run([...base(), "--version", "1.5.0"], pinned).code).toBe(0);
		expect(envOf().NITROBASE_VERSION).toBe("1.5.0");
		// An older installer image never moves an install silently.
		const again = run(base(), pinned);
		expect(again.code).toBe(0);
		expect(envOf().NITROBASE_VERSION).toBe("1.5.0");
		expect(again.out).toMatch(
			/Keeping the installed 1\.5\.0 .*--version 0\.1\.0-beta\.0/,
		);
		// A pre-release image points at the pre-release channel tag.
		expect(again.out).toContain("-installer:beta --version <v>");
	});

	it("ignores the installer image's version outside the image", () => {
		const result = run(base(), { NITROBASE_INSTALLER_VERSION: "0.1.0-beta.0" });
		expect(result.code).toBe(0);
		expect(envOf().NITROBASE_VERSION).toBe("1.4.2");
		expect(result.calls).toMatch(/releases\/latest/);
		expect(
			config([], { NITROBASE_INSTALLER_VERSION: "0.1.0-beta.0" }).image_version,
		).toBe("");
	});

	it("passes the other options through and uninstalls, keeping the mounted folder on purge", () => {
		expect(
			run(
				[
					...base(),
					"--panel-bind",
					"0.0.0.0:8080",
					"--image",
					"registry.example.com/me/nitrobase",
				],
				inContainer(),
			).code,
		).toBe(0);
		expect(envOf()).toMatchObject({
			PANEL_BIND: "0.0.0.0:8080",
			NITROBASE_IMAGE: "registry.example.com/me/nitrobase",
		});
		expect(config(["--dir", dir()], inContainer())).toMatchObject({
			container: "1",
			image: "registry.example.com/me/nitrobase",
		});

		const keep = run(["--dir", dir(), "--uninstall"], inContainer());
		expect(keep.code).toBe(0);
		expect(keep.calls).toMatch(
			/--project-name nitrobase .* down --remove-orphans/,
		);
		expect(existsSync(path.join(dir(), ".env"))).toBe(true);

		const purged = run(
			["--dir", dir(), "--uninstall", "--purge"],
			inContainer({ NITROBASE_PURGE_CONFIRM: `purge ${dir()}` }),
		);
		expect(purged.code).toBe(0);
		expect(purged.calls).toMatch(/down --volumes/);
		// A mount point cannot be removed from inside: it is emptied.
		expect(existsSync(dir())).toBe(true);
		expect(readdirSync(dir())).toEqual([]);
		expect(purged.out).toContain(`The empty folder ${dir()} stays on the host`);
	});

	it("reports a purge that cannot delete the folder", () => {
		const confirm = { NITROBASE_PURGE_CONFIRM: `purge ${dir()}` };
		expect(run(base(), inContainer()).code).toBe(0);
		mock("find", "exit 1");
		const inImage = run(
			["--dir", dir(), "--uninstall", "--purge"],
			inContainer(confirm),
		);
		expect(inImage.code).not.toBe(0);
		expect(inImage.err).toContain(
			`some files in ${dir()} could not be deleted: remove the folder on the host`,
		);
		expect(inImage.out).not.toMatch(/were removed\./);

		rmSync(path.join(bin, "find"));
		mock("rm", "exit 1");
		const onHost = run(["--dir", dir(), "--uninstall", "--purge"], confirm);
		expect(onHost.code).not.toBe(0);
		expect(onHost.err).toContain(
			`${dir()} could not be deleted: remove it yourself`,
		);
	});

	it("uninstall needs the socket too", () => {
		const result = run(
			["--dir", dir(), "--uninstall"],
			inContainer({ MOCK_NO_DAEMON: "1" }),
		);
		expect(result.code).not.toBe(0);
		expect(result.err).toMatch(/mount its socket/);
	});
});

describe("installer and src/config", () => {
	it("names the product after APP_NAME", () => {
		expect(readFileSync(SCRIPT, "utf8")).toContain(
			`readonly PRODUCT_NAME="${APP_NAME}"`,
		);
	});

	it("matches docker-compose.prod.yml (project name, default image)", () => {
		const compose = readFileSync(COMPOSE, "utf8");
		const script = readFileSync(SCRIPT, "utf8");
		const project = /^readonly COMPOSE_PROJECT="([^"]+)"/m.exec(script)?.[1];
		expect(project).toBeTruthy();
		expect(compose).toMatch(new RegExp(`^name: ${project}$`, "m"));
		expect(compose).toContain(
			`\${NITROBASE_IMAGE:-ghcr.io/${RELEASE_REPO_DEFAULT.toLowerCase()}}:`,
		);
		expect(compose).toContain(
			`container_name: ${/^readonly APP_CONTAINER="([^"]+)"/m.exec(script)?.[1]}`,
		);
	});

	it("defaults to the same release repository as the panel", () => {
		expect(readFileSync(SCRIPT, "utf8")).toContain(
			`readonly DEFAULT_REPO="${RELEASE_REPO_DEFAULT}"`,
		);
	});

	it("leaves RELEASE_REPO to the panel default for the official releases", () => {
		expect(run(["--dir", dir(), "--yes"]).code).toBe(0);
		expect(envOf().RELEASE_REPO).toBeUndefined();
		expect(envOf().NITROBASE_IMAGE).toBe(
			`ghcr.io/${RELEASE_REPO_DEFAULT.toLowerCase()}`,
		);
	});

	it("installer image runs this script in container mode", () => {
		const dockerfile = readFileSync(
			path.resolve(__dirname, "../../../../installer/Dockerfile"),
			"utf8",
		);
		const script = readFileSync(SCRIPT, "utf8");
		const target = /^COPY scripts\/install\.sh (\S+)$/m.exec(dockerfile)?.[1];
		expect(target).toBeTruthy();
		expect(dockerfile).toContain(`ENTRYPOINT ["bash", "${target}"]`);
		for (const name of [
			"NITROBASE_INSTALLER_CONTAINER",
			"NITROBASE_INSTALLER_VERSION",
			"NITROBASE_INSTALLER_IMAGE",
		]) {
			expect(dockerfile, name).toMatch(new RegExp(`\\b${name}=`));
			expect(script, name).toContain(`\${${name}:-`);
		}
		expect(dockerfile).toMatch(/^ENV NITROBASE_INSTALLER_CONTAINER=1 /m);
		// Base image pinned to a version and a digest.
		expect(dockerfile).toMatch(
			/^FROM \S+:\d+\.\d+\.\d+-cli@sha256:[0-9a-f]{64}$/m,
		);
	});

	it("removes only its own updater container on uninstall", () => {
		expect(run(base()).code).toBe(0);
		const keep = run(["--dir", dir(), "--uninstall"]);
		expect(keep.code).toBe(0);
		expect(keep.calls).toContain("docker rm -f nitrobase-updater\n");
	});

	it("installs into the default folder without --dir", () => {
		mkdirSync(path.join(root, "opt", "other"), { recursive: true });
		expect(config([]).dir).toBe(dir());
		expect(config(["--dir", "/srv/other"]).dir).toBe("/srv/other");
	});
});

function base(): string[] {
	return ["--dir", dir(), "--repo", "acme/nitrobase", "--yes"];
}
