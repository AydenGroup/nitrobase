import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CacheEntry,
	createGitHubClient,
	type RawRelease,
} from "#/server/services/templates/github.ts";
import { detectInstall, envVersion, splitImage } from "./install";
import {
	findRelease,
	IMAGE_TAG,
	imageTagOf,
	isNewerRelease,
	pickLatestRelease,
	sendsGitHubToken,
} from "./releases";
import {
	canTransition,
	isTerminal,
	outcomeOfUpdater,
	phaseOfLine,
	replayPhases,
	transition,
	UPGRADE_MARKER,
	upgradePhases,
} from "./state-machine";
import {
	parseUpdaterState,
	UPDATER_SCRIPT,
	updaterClearCommand,
	updaterEnv,
	updaterRunCommand,
	updaterStateCommand,
} from "./updater-script";

const release = (tag: string, extra: Partial<RawRelease> = {}): RawRelease => ({
	tag_name: tag,
	name: null,
	published_at: "2026-10-01T00:00:00Z",
	prerelease: false,
	draft: false,
	html_url: `https://github.com/acme/nitrobase/releases/tag/${tag}`,
	...extra,
});

describe("release selection", () => {
	const releases = [
		release("v1.3.0-rc.1", { prerelease: true }),
		release("v1.2.0"),
		release("v1.10.0", { draft: true }),
		release("nightly"),
		release("v1.2.5"),
	];

	it("picks the newest release of the channel", () => {
		expect(pickLatestRelease(releases, "stable")).toMatchObject({
			tag: "v1.2.5",
			version: "1.2.5",
			url: "https://github.com/acme/nitrobase/releases/tag/v1.2.5",
		});
		expect(pickLatestRelease(releases, "prerelease")?.version).toBe(
			"1.3.0-rc.1",
		);
		expect(pickLatestRelease([], "stable")).toBeNull();
	});

	it("compares with the running version", () => {
		const latest = pickLatestRelease(releases, "stable");
		expect(isNewerRelease("1.2.0", latest)).toBe(true);
		expect(isNewerRelease("1.2.5", latest)).toBe(false);
		expect(isNewerRelease("1.3.0", latest)).toBe(false);
		// A dev build never gets an upgrade offer.
		expect(isNewerRelease("dev", latest)).toBe(false);
		expect(isNewerRelease("0.1.0.beta", latest)).toBe(true);
		expect(isNewerRelease("0.1.0-beta.0", latest)).toBe(true);
	});

	it("handles prerelease versions such as 0.1.0-beta.0", () => {
		const betas = [
			release("v0.1.0-beta.0", { prerelease: true }),
			// Not flagged on the host: the version still says pre-release.
			release("v0.1.0-beta.1"),
		];
		// Stable never offers a pre-release, not even to a beta build.
		expect(pickLatestRelease(betas, "stable")).toBeNull();
		const latest = pickLatestRelease(betas, "prerelease");
		expect(latest).toMatchObject({
			tag: "v0.1.0-beta.1",
			version: "0.1.0-beta.1",
			prerelease: true,
		});
		expect(isNewerRelease("0.1.0-beta.0", latest)).toBe(true);
		expect(isNewerRelease("0.1.0-beta.1", latest)).toBe(false);
		expect(
			isNewerRelease(
				"0.1.0-beta.1",
				pickLatestRelease([release("v0.1.0")], "stable"),
			),
		).toBe(true);
		expect(IMAGE_TAG.test(imageTagOf("v0.1.0-beta.0"))).toBe(true);
		expect(findRelease(betas, "0.1.0-beta.1", "prerelease")?.tag).toBe(
			"v0.1.0-beta.1",
		);
		expect(findRelease(betas, "0.1.0-beta.1", "stable")).toBeNull();
		expect(
			detectInstall({
				inspect: JSON.stringify([
					{
						Id: "abc123",
						Config: {
							Image: "ghcr.io/aydengroup/nitrobase:0.1.0-beta.0",
							Hostname: "abc123",
							Labels: {
								"com.docker.compose.project": "nitrobase",
								"com.docker.compose.service": "app",
								"com.docker.compose.project.working_dir": "/opt/nitrobase",
								"com.docker.compose.project.config_files":
									"/opt/nitrobase/docker-compose.yml",
							},
							Healthcheck: { Test: ["CMD-SHELL", "true"] },
						},
					},
				]),
				hostname: "abc123",
				inContainer: true,
			}),
		).toMatchObject({ install: { imageTag: "0.1.0-beta.0" } });
		expect(envVersion("NITROBASE_VERSION=0.1.0-beta.0\n")).toBe("0.1.0-beta.0");
	});

	it("maps release tags to image tags and finds exact releases", () => {
		expect(imageTagOf("v1.2.3")).toBe("1.2.3");
		expect(imageTagOf("1.2.3")).toBe("1.2.3");
		expect(imageTagOf("version-1")).toBe("version-1");
		expect(findRelease(releases, "1.2.0", "stable")?.tag).toBe("v1.2.0");
		expect(findRelease(releases, "1.10.0", "stable")).toBeNull(); // draft
	});

	it("drops non-https release links", () => {
		const [info] = [
			pickLatestRelease(
				[release("v2.0.0", { html_url: "javascript:alert(1)" })],
				"stable",
			),
		];
		expect(info?.url).toBeNull();
	});

	it("sends the GitHub token to GitHub only", () => {
		expect(
			sendsGitHubToken("https://api.github.com/", "https://api.github.com"),
		).toBe(true);
		expect(
			sendsGitHubToken(
				"https://git.example.com/api/v1",
				"https://api.github.com",
			),
		).toBe(false);
	});
});

describe("update check caching", () => {
	function setup() {
		const store = new Map<string, CacheEntry>();
		let now = new Date("2026-10-06T00:00:00Z");
		const calls: { url: string; headers: Record<string, string> }[] = [];
		let respond: () => Response = () =>
			new Response(JSON.stringify([release("v1.2.0")]), {
				status: 200,
				headers: { etag: '"a"' },
			});
		const client = (ttlMs: number, token?: string) =>
			createGitHubClient({
				apiUrl: "https://api.github.com",
				rawUrl: "https://raw.githubusercontent.com",
				token,
				ttlMs,
				now: () => now,
				cache: {
					get: async (key) => store.get(key) ?? null,
					set: async (key, entry) => {
						store.set(key, entry);
					},
				},
				fetch: (async (input: string, init?: RequestInit) => {
					calls.push({
						url: String(input),
						headers: init?.headers as Record<string, string>,
					});
					return respond();
				}) as typeof fetch,
			});
		return {
			client,
			calls,
			advance: (ms: number) => {
				now = new Date(now.getTime() + ms);
			},
			respondWith: (fn: () => Response) => {
				respond = fn;
			},
		};
	}

	it("reuses the cached list within the TTL and revalidates after it", async () => {
		const t = setup();
		const hour = 60 * 60_000;
		expect(
			pickLatestRelease(
				await t.client(6 * hour).listReleases("acme/nitrobase"),
				"stable",
			)?.version,
		).toBe("1.2.0");
		await t.client(6 * hour).listReleases("acme/nitrobase");
		expect(t.calls).toHaveLength(1);
		t.advance(7 * hour);
		t.respondWith(() => new Response(null, { status: 304 }));
		const again = await t.client(6 * hour).listReleases("acme/nitrobase");
		expect(again[0].tag_name).toBe("v1.2.0");
		expect(t.calls).toHaveLength(2);
		expect(t.calls[1].headers["If-None-Match"]).toBe('"a"');
	});

	it("'Check now' (TTL 0) asks again; errors fall back to the cache", async () => {
		const t = setup();
		await t.client(60_000, "ghp_secret").listReleases("acme/nitrobase");
		expect(t.calls[0].headers.Authorization).toBe("Bearer ghp_secret");
		t.respondWith(() => new Response("boom", { status: 502 }));
		const stale = await t.client(0).listReleases("acme/nitrobase");
		expect(stale[0].tag_name).toBe("v1.2.0");
		expect(t.calls).toHaveLength(2);
	});
});

const inspect = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify([
		{
			Id: "abc123def456aaaa",
			Config: {
				Hostname: "abc123def456",
				Image: "ghcr.io/acme/nitrobase:1.2.0",
				Labels: {
					"com.docker.compose.project": "nitrobase",
					"com.docker.compose.service": "app",
					"com.docker.compose.project.working_dir": "/opt/nitrobase",
					"com.docker.compose.project.config_files":
						"/opt/nitrobase/docker-compose.yml",
				},
				Healthcheck: {
					Test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/api/health"],
				},
				...overrides,
			},
		},
	]);

describe("install detection", () => {
	const detect = (json: string | null, extra = {}) =>
		detectInstall({
			inspect: json,
			hostname: "abc123def456",
			inContainer: true,
			...extra,
		});

	it("reads the compose install the installer creates", () => {
		expect(detect(inspect())).toEqual({
			install: {
				containerId: "abc123def456aaaa",
				image: "ghcr.io/acme/nitrobase:1.2.0",
				imageRepo: "ghcr.io/acme/nitrobase",
				imageTag: "1.2.0",
				project: "nitrobase",
				service: "app",
				workingDir: "/opt/nitrobase",
				configFiles: ["/opt/nitrobase/docker-compose.yml"],
			},
		});
	});

	it("explains why the upgrade is unavailable", () => {
		expect(detect(inspect(), { inContainer: false })).toEqual({
			problem: "not_container",
		});
		expect(detect(null)).toEqual({ problem: "not_found" });
		expect(detect(inspect(), { hostname: "other" })).toEqual({
			problem: "not_this_container",
		});
		expect(detect(inspect({ Labels: {} }))).toEqual({ problem: "not_compose" });
		expect(detect(inspect({ Image: "nitrobase:latest" }))).toEqual({
			problem: "image_unpinned",
		});
		expect(detect(inspect({ Image: "sha256:abcdef" }))).toEqual({
			problem: "image_unpinned",
		});
		expect(detect(inspect({ Healthcheck: null }))).toEqual({
			problem: "no_healthcheck",
		});
		expect(
			detect(
				inspect({
					Labels: {
						"com.docker.compose.project": "nitrobase",
						"com.docker.compose.service": "app",
						"com.docker.compose.project.working_dir": "/opt/x:y",
						"com.docker.compose.project.config_files": "/opt/x/c.yml",
					},
				}),
			),
		).toEqual({ problem: "not_compose" });
	});

	it("splits images and reads NITROBASE_VERSION", () => {
		expect(splitImage("localhost:5000/sb:1.0")).toEqual({
			repo: "localhost:5000/sb",
			tag: "1.0",
		});
		expect(splitImage("localhost:5000/sb")).toEqual({
			repo: "localhost:5000/sb",
			tag: null,
		});
		expect(envVersion("NITROBASE_VERSION=1.2.0\n")).toBe("1.2.0");
		expect(
			envVersion('NITROBASE_VERSION="1.2.0"\nNITROBASE_VERSION=1.3.0'),
		).toBe("1.3.0");
		expect(envVersion("NITROBASE_VERSION=\n")).toBeNull();
		expect(envVersion("OTHER=1\n")).toBeNull();
	});
});

describe("upgrade state machine", () => {
	it("allows only the designed transitions", () => {
		expect(transition("preflight", "backup")).toBe("backup");
		expect(() => transition("preflight", "switching")).toThrow();
		expect(() => transition("backup", "handoff")).toThrow();
		expect(canTransition("health", "rolling_back")).toBe(true);
		expect(canTransition("succeeded", "rolling_back")).toBe(false);
		for (const phase of upgradePhases) {
			expect(isTerminal(phase)).toBe(
				["succeeded", "rolled_back", "failed"].includes(phase),
			);
		}
	});

	it("follows the updater's markers", () => {
		const lines = [
			`${UPGRADE_MARKER} switching`,
			"Switching...",
			`${UPGRADE_MARKER} health`,
			`${UPGRADE_MARKER} succeeded`,
		];
		expect(phaseOfLine(lines[0])).toBe("switching");
		expect(phaseOfLine("plain line")).toBeNull();
		expect(phaseOfLine(`${UPGRADE_MARKER} bogus`)).toBeNull();
		expect(UPGRADE_MARKER).toBe("@@nitrobase-upgrade");
		expect(phaseOfLine("@@nitrobase-upgrade health")).toBe("health");
		expect(phaseOfLine("@@other-upgrade health")).toBeNull();
		expect(replayPhases("handoff", lines)).toBe("succeeded");
		// Out-of-order markers never move it backwards.
		expect(
			replayPhases("handoff", [
				`${UPGRADE_MARKER} switching`,
				`${UPGRADE_MARKER} health`,
				`${UPGRADE_MARKER} switching`,
				`${UPGRADE_MARKER} rolling_back`,
				`${UPGRADE_MARKER} rolled_back`,
			]),
		).toBe("rolled_back");
	});

	it("derives the outcome from the updater's exit", () => {
		expect(outcomeOfUpdater(0, "succeeded")).toBe("succeeded");
		// Exit 0 without the final marker is not trusted.
		expect(outcomeOfUpdater(0, "health")).toBe("failed");
		expect(outcomeOfUpdater(10, "rolled_back")).toBe("rolled_back");
		expect(outcomeOfUpdater(11, "failed")).toBe("failed");
		// Refused before switching: the old version never stopped.
		expect(outcomeOfUpdater(2, "handoff")).toBe("rolled_back");
		expect(outcomeOfUpdater(137, "health")).toBe("failed");
	});
});

describe("updater", () => {
	const install = {
		containerId: "abc",
		image: "ghcr.io/acme/nitrobase:1.2.0",
		imageRepo: "ghcr.io/acme/nitrobase",
		imageTag: "1.2.0",
		project: "nitrobase",
		service: "app",
		workingDir: "/opt/nitrobase",
		configFiles: ["/opt/nitrobase/docker-compose.yml"],
	};
	const input = {
		install,
		targetVersion: "1.3.0",
		previousVersion: "1.2.0",
		healthTimeoutSeconds: 300,
		healthPollSeconds: 3,
		logTailLines: 40,
		updaterImage: "docker:28.5.1-cli",
		updaterContainer: "nitrobase-updater",
		dockerSocket: "/var/run/docker.sock",
		deploymentId: "00000000-0000-4000-8000-000000000001",
		instanceId: "inst_1",
	};

	it("passes every value as environment, never inside the script", () => {
		const env = updaterEnv(input);
		expect(env).toMatchObject({
			SB_DIR: "/opt/nitrobase",
			SB_TARGET: "1.3.0",
			SB_PREVIOUS: "1.2.0",
			COMPOSE_FILE: "/opt/nitrobase/docker-compose.yml",
		});
		expect(UPDATER_SCRIPT).not.toContain("1.3.0");
		expect(UPDATER_SCRIPT).not.toContain("/opt/nitrobase");
		const command = updaterRunCommand(input, "nitrobase_app");
		expect(command).toContain("-e 'SB_CONTAINER=nitrobase_app'");
		expect(command).toContain(
			"--label 'nitrobase.upgrade=00000000-0000-4000-8000-000000000001'",
		);
		expect(command).toContain("--label 'nitrobase.instance=");
		expect(updaterStateCommand("nitrobase-updater")).toBe(
			`docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{index .Config.Labels "nitrobase.upgrade"}}' 'nitrobase-updater' 2>/dev/null || true`,
		);
		expect(command).toContain("-v '/var/run/docker.sock:/var/run/docker.sock'");
		expect(command).toContain("-v '/opt/nitrobase:/opt/nitrobase'");
	});

	it("clears a finished updater, refuses a running one", () => {
		const command = updaterClearCommand("nitrobase-updater");
		const dir = mkdtempSync(path.join(tmpdir(), "updater-clear-"));
		try {
			const log = path.join(dir, "log");
			writeFileSync(
				path.join(dir, "docker"),
				`#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in *"$RUNNING"*'{{.State.Running}}'*|*'{{.State.Running}}'*"$RUNNING") [ -n "$RUNNING" ] && echo true;; esac\nexit 0\n`,
				{ mode: 0o755 },
			);
			const sh = (running: string) =>
				spawnSync("sh", ["-c", command], {
					encoding: "utf8",
					env: {
						PATH: `${dir}:/usr/bin:/bin`,
						RUNNING: running,
					} as unknown as NodeJS.ProcessEnv,
				});
			expect(sh("").status).toBe(0);
			expect(readFileSync(log, "utf8")).toContain("rm -f nitrobase-updater");
			const busy = sh("nitrobase-updater");
			expect(busy.status).toBe(1);
			expect(busy.stderr).toContain("an updater is already running");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		expect(() => updaterClearCommand("x;rm")).toThrow();
	});

	it("refuses unsafe input", () => {
		expect(() => updaterEnv({ ...input, targetVersion: "1.3.0;rm" })).toThrow();
		expect(() => updaterEnv({ ...input, targetVersion: "1.2.0" })).toThrow();
		expect(() =>
			updaterEnv({
				...input,
				install: { ...install, workingDir: "/opt/sb\nx" },
			}),
		).toThrow();
		expect(() =>
			updaterRunCommand({ ...input, dockerSocket: "/run/x;sh" }, "app"),
		).toThrow();
	});

	it("parses the updater state", () => {
		expect(parseUpdaterState("exited 10 abc\n")).toEqual({
			status: "exited",
			exitCode: 10,
			deploymentId: "abc",
		});
		expect(parseUpdaterState("")).toBeNull();
	});

	it("is valid sh", () => {
		const result = spawnSync("sh", ["-n", "-c", UPDATER_SCRIPT], {
			encoding: "utf8",
		});
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});

describe("version line handling", () => {
	const setVersion = (env: string, version: string) => {
		const dir = mkdtempSync(path.join(tmpdir(), "sb-env-"));
		writeFileSync(path.join(dir, ".env"), env);
		const script = UPDATER_SCRIPT.split("\nwait_healthy()")[0];
		const result = spawnSync(
			"sh",
			["-c", `${script}\nset_version "$1"`, "sb", version],
			{
				encoding: "utf8",
				env: {
					SB_DIR: dir,
					PATH: process.env.PATH,
				} as unknown as NodeJS.ProcessEnv,
			},
		);
		const out = readFileSync(path.join(dir, ".env"), "utf8");
		rmSync(dir, { recursive: true, force: true });
		return { status: result.status, out };
	};

	it("rewrites the line the detection reads, spaces and quotes included", () => {
		for (const line of [
			"NITROBASE_VERSION=1.2.0",
			"  NITROBASE_VERSION = 1.2.0",
			'NITROBASE_VERSION="1.2.0"',
		]) {
			expect(envVersion(`A=1\n${line}\n`)).toBe("1.2.0");
			const { status, out } = setVersion(`A=1\n${line}\nB=2\n`, "1.3.0");
			expect(status).toBe(0);
			expect(out).toBe("A=1\nNITROBASE_VERSION=1.3.0\nB=2\n");
			expect(envVersion(out)).toBe("1.3.0");
		}
		// Missing: appended.
		expect(setVersion("A=1\n", "1.3.0").out).toBe(
			"A=1\nNITROBASE_VERSION=1.3.0\n",
		);
	});
});
