import { describe, expect, it } from "vitest";
import {
	BASE_PACKAGES,
	hostOsFamilies,
	hostOsFamily,
	SUPPORTED_OS_IDS,
} from "./host-os";
import { appBaseUrl, loadConfig } from "./server";

describe("host OS families", () => {
	it("picks the family from the os-release ID, never ID_LIKE derivatives", () => {
		expect(hostOsFamily("ubuntu")).toBe(hostOsFamilies.debian);
		expect(hostOsFamily("debian")).toBe(hostOsFamilies.debian);
		expect(hostOsFamily("linuxmint")).toBeNull();
		expect(hostOsFamily("alpine")).toBeNull();
		expect(SUPPORTED_OS_IDS).toEqual(["ubuntu", "debian"]);
	});

	it("installs packages and Docker from the configured repository", () => {
		const debian = hostOsFamilies.debian;
		expect(debian.installPackagesScript(BASE_PACKAGES)).toContain(
			"apt-get install -y -qq ca-certificates curl wget git jq openssl",
		);
		const docker = debian.installDockerScript();
		expect(docker).toContain(
			`repo='https://download.docker.com/linux'/"$distro"`,
		);
		expect(docker).toContain(
			"apt-get install -y -qq 'docker-ce' 'docker-ce-cli' 'containerd.io' 'docker-buildx-plugin' 'docker-compose-plugin'",
		);
		expect(debian.noise.test("Unpacking docker-ce (5:29) ...")).toBe(true);
	});
});

describe("bootstrap env values", () => {
	it("rejects Docker package names that are not plain package names", () => {
		const load = (DOCKER_PACKAGES: string) => () =>
			loadConfig({ ...process.env, DOCKER_PACKAGES });
		expect(load("docker-ce,containerd.io")).not.toThrow();
		expect(load("docker-ce;reboot")).toThrow();
		expect(load("$(id)")).toThrow();
	});
});

describe("config helpers", () => {
	it("normalizes APP_URL (no trailing slash, http(s) only)", () => {
		const url = (APP_URL?: string) =>
			appBaseUrl(loadConfig({ ...process.env, APP_URL }));
		expect(url("https://panel.example.com/")).toBe("https://panel.example.com");
		expect(url("http://10.0.0.5:3000")).toBe("http://10.0.0.5:3000");
		expect(url("")).toBeNull();
		expect(url(undefined)).toBeNull();
		expect(url("not a url")).toBeNull();
		expect(url("ftp://panel.example.com")).toBeNull();
	});

	it("reads bootstrap and HSTS tunables from the environment", () => {
		const config = loadConfig({
			...process.env,
			DOCKER_PACKAGES: "docker-ce, docker-compose-plugin",
			TRAEFIK_HSTS_PRELOAD: "false",
		});
		expect(config.DOCKER_PACKAGES).toEqual([
			"docker-ce",
			"docker-compose-plugin",
		]);
		expect(config.TRAEFIK_HSTS_PRELOAD).toBe(false);
		expect(config.TRAEFIK_HSTS_SECONDS).toBe(31_536_000);
	});
});
