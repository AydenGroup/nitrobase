import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { hostOsFamilies } from "#/config/host-os.ts";
import type { ExecResult, Executor } from "./executor";
import {
	assertServerUsable,
	bootstrapServer,
	gatherSystemInfo,
	isPackageNoise,
	parseDockerVersion,
	parseKeyValueLines,
	systemInfoScript,
	traefikConfigHash,
	traefikPortFlags,
	traefikStaticConfig,
	tunnelNetworkScript,
} from "./server-setup";

function fakeExecutor(stdout: string, exitCode = 0): Executor {
	const result: ExecResult = { stdout, stderr: "", exitCode };
	return {
		kind: "local",
		exec: vi.fn(async () => result),
		upload: vi.fn(async () => {}),
		readFile: vi.fn(async () => ""),
		shell: vi.fn(),
		close: vi.fn(),
	};
}

const ubuntu = [
	"uid=0",
	"pm_apt-get=/usr/bin/apt-get",
	"systemctl=/usr/bin/systemctl",
	"os_id=ubuntu",
	"os=Ubuntu 24.04 LTS",
	"kernel=6.8.0",
	"arch=x86_64",
	"docker=Docker version 27.3.1, build ce12230",
	"port80=available",
	"port443=used",
	"traefik=missing",
].join("\n");

describe("parseKeyValueLines", () => {
	it("splits on the first '=' only", () => {
		expect(parseKeyValueLines("a=1\nb=x=y\nnoise\n=bad")).toEqual({
			a: "1",
			b: "x=y",
		});
	});
});

describe("parseDockerVersion", () => {
	it("extracts the semver", () => {
		expect(parseDockerVersion("Docker version 27.3.1, build x")).toBe("27.3.1");
		expect(parseDockerVersion("not_installed")).toBeNull();
	});
});

describe("gatherSystemInfo", () => {
	it("uses a single exec round-trip and parses the result", async () => {
		const executor = fakeExecutor(ubuntu);
		const info = await gatherSystemInfo(executor);
		expect(executor.exec).toHaveBeenCalledTimes(1);
		expect(executor.exec).toHaveBeenCalledWith(systemInfoScript());
		expect(info).toMatchObject({
			os: "Ubuntu 24.04 LTS",
			architecture: "x86_64",
			dockerInstalled: true,
			dockerVersion: "27.3.1",
			portsAvailable: { port80: true, port443: false },
			traefikContainer: false,
		});
	});

	it("rejects non-root users", async () => {
		await expect(
			gatherSystemInfo(fakeExecutor(ubuntu.replace("uid=0", "uid=1000"))),
		).rejects.toThrow(/root access/);
	});

	it("rejects unsupported distributions", async () => {
		await expect(
			gatherSystemInfo(
				fakeExecutor(ubuntu.replace("os_id=ubuntu", "os_id=alpine")),
			),
		).rejects.toThrow(/alpine\. Supported: ubuntu, debian/);
	});

	it("rejects a supported distribution without its package manager", async () => {
		await expect(
			gatherSystemInfo(
				fakeExecutor(
					ubuntu.replace("pm_apt-get=/usr/bin/apt-get", "pm_apt-get=missing"),
				),
			),
		).rejects.toThrow(/apt-get/);
	});
});

describe("bootstrapServer: changed (BUG-002)", () => {
	const portsFree = ubuntu.replace("port443=used", "port443=available");

	it("reports an unchanged server when it cannot be reached", async () => {
		const executor = fakeExecutor("");
		vi.mocked(executor.exec).mockRejectedValue(new Error("handshake timeout"));
		const result = await bootstrapServer(executor, "me@example.com");
		expect(result).toMatchObject({ success: false, changed: false });
	});

	it("reports an unchanged server for a refusal of the read-only checks", async () => {
		const result = await bootstrapServer(
			fakeExecutor(ubuntu),
			"me@example.com",
		);
		expect(result.success).toBe(false);
		expect(result.changed).toBe(false);
		expect((result.error as { code?: string }).code).toBe("SETUP_PORTS_BUSY");
	});

	it("reports a possibly changed server once installing started", async () => {
		const executor = fakeExecutor(portsFree);
		vi.mocked(executor.exec)
			.mockResolvedValueOnce({ stdout: portsFree, stderr: "", exitCode: 0 })
			.mockRejectedValue(new Error("connection lost"));
		const result = await bootstrapServer(executor, "me@example.com");
		expect(result).toMatchObject({ success: false, changed: true });
	});
});

describe("traefik config", () => {
	it("quotes the ACME email and stores certs outside the dynamic dir", () => {
		const config = traefikStaticConfig("ops@example.org");
		expect(parseYaml(config).certificatesResolvers.letsencrypt.acme.email).toBe(
			"ops@example.org",
		);
		expect(parseYaml(config).providers.swarm).toBeUndefined();
		expect(config).toContain("storage: /etc/nitrobase/traefik/acme/acme.json");
		// Tunnel traffic gets its own entrypoint (not published on the host).
		// Bound to Traefik's address in the private tunnel network only.
		expect(parseYaml(config).entryPoints.tunnel.address).toBe(
			"172.31.254.2:8081",
		);
	});

	it("hash changes with the config", () => {
		const a = traefikConfigHash(traefikStaticConfig("a@example.org"));
		const b = traefikConfigHash(traefikStaticConfig("b@example.org"));
		expect(a).toMatch(/^[0-9a-f]{16}$/);
		expect(a).not.toBe(b);
		expect(traefikConfigHash(traefikStaticConfig("a@example.org"))).toBe(a);
		// Tunnel-only recreates the proxy without host ports; published ports
		// keep the old hash (no restart on upgrade).
		const config = traefikStaticConfig("a@example.org");
		expect(traefikConfigHash(config, { publishPorts: true })).toBe(a);
		expect(traefikConfigHash(config, { publishPorts: false })).not.toBe(a);
	});

	it("creates the private tunnel network with its fixed subnet", () => {
		const script = tunnelNetworkScript();
		expect(script).toContain(
			"docker network create --driver bridge --subnet '172.31.254.0/29' 'nitrobase-tunnel'",
		);
		// An existing network with another subnet is an error (the entrypoint
		// address would not exist), not silently reused.
		expect(script).toContain("exit 1");
	});

	it("publishes 80/443 unless the server is tunnel-only", () => {
		expect(traefikPortFlags(true)).toContain("-p 80:80");
		expect(traefikPortFlags(true)).toContain("-p 443:443/tcp");
		expect(traefikPortFlags(false)).not.toContain("-p ");
		// Both keep the multi-line `docker run` going.
		expect(traefikPortFlags(false).endsWith("\\")).toBe(true);
		expect(traefikPortFlags(true).endsWith("\\")).toBe(true);
	});
});

describe("isPackageNoise (debian family)", () => {
	const isAptNoise = (line: string) =>
		isPackageNoise(hostOsFamilies.debian, line);
	it("filters apt progress but keeps package setup lines", () => {
		expect(isAptNoise("(Reading database ... 45%")).toBe(true);
		expect(isAptNoise("Unpacking docker-ce (5:29) ...")).toBe(true);
		expect(isAptNoise("Get:1 http://deb.debian.org bookworm InRelease")).toBe(
			true,
		);
		expect(isAptNoise("Setting up docker-ce (5:29.8.2) ...")).toBe(false);
		expect(isAptNoise("E: Unable to locate package")).toBe(false);
	});
});

describe("servers the panel may write to", () => {
	const ours = { foreign: [], claimed: true };

	it("refuses another instance's server unless taking it over", () => {
		const foreign = { ...ours, foreign: ["other"] };
		expect(() => assertServerUsable(foreign)).toThrow(
			expect.objectContaining({ code: "SERVER_MANAGED_ELSEWHERE" }),
		);
		expect(() => assertServerUsable(foreign, { takeover: true })).not.toThrow();
		expect(() => assertServerUsable(ours)).not.toThrow();
	});
});
