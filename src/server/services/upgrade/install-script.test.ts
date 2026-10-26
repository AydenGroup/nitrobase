import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
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
		'echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "/dev/x 100000000 1 90000000 1% /"',
	);
	mock("ss", "exit 0");
	mock("hostname", 'echo "203.0.113.7"');
	mock("sleep", "exit 0");
	mock("apt-get", `${log}\nexit 0`);
	mock(
		"curl",
		[
			log,
			'out=""; url=""',
			'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -H) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done',
			'case "$url" in',
			`  *docker-compose.prod.yml) cp ${JSON.stringify(COMPOSE)} "$out";;`,
			'  */gpg) echo "-----BEGIN PGP PUBLIC KEY BLOCK-----" > "$out";;',
			'  */releases/latest) echo \'{"url":"x","tag_name":"v1.4.2","name":"Nitrobase 1.4.2"}\';;',
			"  *) exit 22;;",
			"esac",
		].join("\n"),
	);
	mock(
		"docker",
		[
			log,
			'case "$*" in',
			'  "compose version") exit 0;;',
			"  version*) echo 27.3.1;;",
			'  "inspect -f"*) echo healthy;;',
			"  inspect*) exit 1;;",
			"  *) exit 0;;",
			"esac",
		].join("\n"),
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

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
		mock(
			"curl",
			`echo "$(basename "$0") $*" >> ${JSON.stringify(callLog)}\necho '{"tag_name":"v1.0 && reboot"}'`,
		);
		const api = run(base());
		expect(api.code).not.toBe(0);
		expect(api.err).toMatch(/invalid version from the latest release/);
	});

	it("installs the newest pre-release while no stable release exists", () => {
		mock(
			"curl",
			[
				`echo "$(basename "$0") $*" >> ${JSON.stringify(callLog)}`,
				'out=""; url=""',
				'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -H) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done',
				'case "$url" in',
				`  *docker-compose.prod.yml) cp ${JSON.stringify(COMPOSE)} "$out";;`,
				"  */releases/latest) exit 22;;",
				'  */releases?per_page=*) echo \'[{"url":"x","tag_name":"v0.1.0-beta.1","prerelease":true},{"tag_name":"v0.1.0-beta.0"}]\';;',
				"  *) exit 22;;",
				"esac",
			].join("\n"),
		);
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
	});

	it("installs Docker from the official repository when missing", () => {
		rmSync(path.join(bin, "docker"));
		mock("dpkg", "echo amd64");
		const apt = path.join(root, "apt");
		const result = run(base(), { NITROBASE_APT_ETC: apt });
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
