import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	appImagesCommand,
	builderLimitsCommand,
	buildxCommand,
	CLONE_SCRIPT,
	ensureBuilderCommand,
	gitConfigEnv,
	gitContainerCommand,
	gitSweepCommand,
	imageAppLabelCommand,
	imageLabels,
	isGitWorkDir,
	parseCloneOutput,
	parseProbeOutput,
	planHasSecretValue,
	RAILPACK_SECRET_PLACEHOLDER,
	railpackPrepareCommand,
	relabelCommand,
	removeAppImagesScript,
	staticDockerfile,
} from "./commands";
import { parseGitUrl } from "./url";

const https = parseGitUrl("https://github.com/acme/app.git", {
	allowPrivate: false,
});
const ssh = parseGitUrl("git@github.com:acme/app.git", { allowPrivate: false });
const builder = { name: "nitrobase-builder", image: "moby/buildkit:v0.33.1" };

describe("git container command", () => {
	it("passes repository values as quoted positional parameters", () => {
		const command = gitContainerCommand(
			{
				image: "alpine/git:v2.54.0",
				workspace: "/etc/nitrobase/apps/git-1234abcd/build/run-1/src",
				url: https,
				protocols: ["https"],
				pins: [{ host: "github.com", port: 443, address: "140.82.121.4" }],
				auth: {
					authDir: null,
					kind: "none",
					knownHostsDir: "/etc/nitrobase/apps/git-1234abcd/build/known",
				},
				memoryMb: 512,
			},
			CLONE_SCRIPT,
			[https.url, "feat/it's", ""],
		);
		expect(
			command.startsWith(
				"docker run --rm --network bridge --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 512m --entrypoint sh ",
			),
		).toBe(true);
		// Values never spliced into the script: positional, single-quoted.
		expect(
			command.endsWith(
				` sb 'https://github.com/acme/app.git' 'feat/it'\\''s' ''`,
			),
		).toBe(true);
		expect(command).toContain(
			"-v '/etc/nitrobase/apps/git-1234abcd/build/run-1/src:/workspace'",
		);
		expect(command).not.toContain("/run/git:ro");
		expect(command).toContain(
			"-e 'GIT_CONFIG_VALUE_11=github.com:443:140.82.121.4'",
		);
		expect(command).toContain("-e 'GIT_CONFIG_KEY_1=protocol.https.allow'");
		expect(command).toContain("-e 'GIT_TERMINAL_PROMPT=0'");
	});

	it("mounts credentials read-only and pins SSH hosts", () => {
		const command = gitContainerCommand(
			{
				image: "alpine/git:v2.54.0",
				workspace: "/etc/nitrobase/w",
				url: ssh,
				protocols: ["ssh"],
				pins: [{ host: "github.com", port: 22, address: "140.82.121.4" }],
				auth: {
					authDir: "/etc/nitrobase/a",
					kind: "deploy_key",
					knownHostsDir: "/etc/nitrobase/k",
				},
				memoryMb: 100,
			},
			"true",
			[],
		);
		expect(command).toContain("-v '/etc/nitrobase/a:/run/git:ro'");
		expect(command).toContain("--memory 256m");
		expect(command).toContain(
			"-e 'GIT_SSH_COMMAND=ssh -i /run/git/key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/run/known/known_hosts -o ConnectTimeout=20 -o HostName=140.82.121.4 -o HostKeyAlias=github.com'",
		);
	});

	it("refuses relative or dotted host paths", () => {
		expect(() =>
			gitContainerCommand(
				{
					image: "x",
					workspace: "/etc/nitrobase/../tmp",
					url: https,
					protocols: ["https"],
					pins: [],
					auth: { authDir: null, kind: "none", knownHostsDir: "/k" },
					memoryMb: 512,
				},
				"true",
				[],
			),
		).toThrow();
	});

	it("pins every checked host (multi-valued curloptResolve)", () => {
		const env = gitConfigEnv({
			protocols: ["https", "https", "ssh"],
			pins: [
				{ host: "github.com", port: 443, address: "1.2.3.4" },
				{ host: "gitlab.com", port: 443, address: "2001:db8::1" },
			],
		});
		const values = Object.entries(env)
			.filter(([key]) => key.startsWith("GIT_CONFIG_KEY_"))
			.map(([key, name]) => [name, env[key.replace("KEY", "VALUE")]]);
		expect(values.filter(([name]) => name === "http.curloptResolve")).toEqual([
			["http.curloptResolve", "github.com:443:1.2.3.4"],
			["http.curloptResolve", "gitlab.com:443:[2001:db8::1]"],
		]);
		expect(
			values.filter(([name]) => /^protocol\.\w+\.allow$/.test(name)),
		).toEqual([
			["protocol.https.allow", "always"],
			["protocol.ssh.allow", "always"],
		]);
	});

	it("allows only the URL's protocol and never follows redirects", () => {
		const env = gitConfigEnv({ protocols: ["https"], pins: [] });
		const pairs = Object.fromEntries(
			Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
				env[`GIT_CONFIG_KEY_${i}`],
				env[`GIT_CONFIG_VALUE_${i}`],
			]),
		);
		expect(pairs["protocol.allow"]).toBe("never");
		expect(pairs["protocol.https.allow"]).toBe("always");
		expect(pairs["protocol.file.allow"]).toBeUndefined();
		expect(pairs["http.followRedirects"]).toBe("false");
		expect(pairs["credential.helper"]).toBe("");
		expect(pairs["core.hooksPath"]).toBe("/dev/null");
		expect(pairs["http.curloptResolve"]).toBeUndefined();
	});
});

describe("clone/probe output", () => {
	it("parses commit, metadata and submodules", () => {
		const out = parseCloneOutput(
			[
				"noise",
				`@@SB commit ${"a".repeat(40)}`,
				"@@SB meta Jane Doe\x1f2026-10-05T10:00:00+02:00\x1fFix: it's done",
				"@@SB submodule ../lib.git",
			].join("\n"),
		);
		expect(out).toEqual({
			commitSha: "a".repeat(40),
			author: "Jane Doe",
			committedAt: "2026-10-05T10:00:00+02:00",
			message: "Fix: it's done",
			submodules: ["../lib.git"],
		});
		expect(() => parseCloneOutput("@@SB commit nope")).toThrow();
	});

	it("parses probed files", () => {
		const probe = parseProbeOutput(
			[
				"@@SB file Dockerfile",
				"@@SB file src/",
				`@@SB content Dockerfile ${Buffer.from("FROM x\nEXPOSE 8080\n").toString("base64")}`,
			].join("\n"),
		);
		expect(probe.files).toEqual(["Dockerfile", "src/"]);
		expect(probe.contents.Dockerfile).toBe("FROM x\nEXPOSE 8080\n");
	});
});

describe("builds", () => {
	it("builds with exact quoting, labels, args and secrets", () => {
		expect(
			buildxCommand({
				builder,
				tag: `git-1234abcd:${"b".repeat(40)}`,
				context: "/etc/nitrobase/apps/git-1234abcd/build/run-1/src/web",
				file: "/etc/nitrobase/apps/git-1234abcd/build/run-1/src/web/Dockerfile",
				target: "prod",
				buildArgs: { NODE_ENV: "production", GREETING: "it's $HOME" },
				secrets: { NPM_TOKEN: "/etc/nitrobase/s/NPM_TOKEN" },
				labels: imageLabels({
					appId: "11111111-2222-4333-8444-555555555555",
					instanceId: "inst_1",
					commitSha: "b".repeat(40),
				}),
			}),
		).toBe(
			[
				"docker buildx build --builder 'nitrobase-builder' --progress plain --load --provenance=false",
				`-t 'git-1234abcd:${"b".repeat(40)}'`,
				"-f '/etc/nitrobase/apps/git-1234abcd/build/run-1/src/web/Dockerfile'",
				"--target 'prod'",
				"--label 'nitrobase.app=11111111-2222-4333-8444-555555555555'",
				"--label 'nitrobase.instance=inst_1'",
				`--label 'nitrobase.commit=${"b".repeat(40)}'`,
				"--build-arg 'NODE_ENV=production'",
				"--build-arg 'GREETING=it'\\''s $HOME'",
				"--secret 'id=NPM_TOKEN,src=/etc/nitrobase/s/NPM_TOKEN'",
				"'/etc/nitrobase/apps/git-1234abcd/build/run-1/src/web'",
			].join(" "),
		);
	});

	it("refuses bad tags, args and secret ids", () => {
		const base = {
			builder,
			tag: "git-1:abc",
			context: "/c",
			file: "/c/Dockerfile",
			buildArgs: {},
			secrets: {},
			labels: {},
		};
		expect(() => buildxCommand({ ...base, tag: "Bad Tag" })).toThrow();
		expect(() =>
			buildxCommand({ ...base, buildArgs: { "A B": "x" } }),
		).toThrow();
		expect(() =>
			buildxCommand({ ...base, secrets: { "x,src=/etc/shadow": "/y" } }),
		).toThrow();
	});

	it("puts static build commands in JSON exec form", () => {
		const file = staticDockerfile({
			buildImage: "node:22-alpine",
			serveImage: "joseluisq/static-web-server:2.44.0",
			buildCommand: `npm ci && echo "it's" && npm run build`,
			outputDir: "dist",
			secretNames: ["NPM_TOKEN"],
		});
		expect(file).toBe(
			[
				"FROM node:22-alpine AS build",
				"WORKDIR /src",
				"COPY . .",
				`RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN ["sh","-c","npm ci && echo \\"it's\\" && npm run build"]`,
				"FROM joseluisq/static-web-server:2.44.0",
				'COPY --from=build ["/src/dist/","/public/"]',
				"",
			].join("\n"),
		);
		expect(
			staticDockerfile({
				buildImage: "x",
				serveImage: "sws",
				buildCommand: "",
				outputDir: ".",
				secretNames: [],
			}),
		).toBe('FROM sws\nCOPY ["./","/public/"]\n');
	});

	it("gives Railpack secret names only, never values", () => {
		const command = railpackPrepareCommand({
			toolsImage: "nitrobase-railpack:v0.40.1",
			context: "/c",
			planDir: "/p",
			secretNames: ["API_KEY"],
		});
		expect(command).toBe(
			"docker run --rm --network bridge --cap-drop ALL --security-opt no-new-privileges -v '/c:/app:ro' -v '/p:/out' --entrypoint railpack 'nitrobase-railpack:v0.40.1' prepare /app --plan-out /out/railpack-plan.json --info-out /out/railpack-info.json --env 'API_KEY=__nitrobase_secret__'",
		);
		expect(() =>
			railpackPrepareCommand({
				toolsImage: "x",
				context: "/c",
				planDir: "/p",
				secretNames: ["A;rm"],
			}),
		).toThrow();
	});

	it("relabels, limits and sets up the builder", () => {
		expect(relabelCommand("app:x-raw", "app:x", { "nitrobase.app": "1" })).toBe(
			"printf 'FROM %s\\n' 'app:x-raw' | DOCKER_BUILDKIT=1 docker build -q --label 'nitrobase.app=1' -t 'app:x' - >/dev/null && docker image rm 'app:x-raw' >/dev/null",
		);
		expect(builderLimitsCommand(builder, { memoryMb: 1536, cpus: 1.5 })).toBe(
			"docker update --memory 1536m --memory-swap 1536m --cpus 1.50 'buildx_buildkit_nitrobase-builder0' >/dev/null",
		);
		expect(ensureBuilderCommand(builder)).toContain(
			"docker buildx create --name 'nitrobase-builder' --driver docker-container --driver-opt 'image=moby/buildkit:v0.33.1'",
		);
	});

	it("removes images without force", () => {
		expect(removeAppImagesScript(["git-1:a", "bad tag"])).toBe(
			`if docker image rm -- 'git-1:a' >/dev/null 2>&1; then echo "removed git-1:a"; else echo "kept git-1:a"; fi`,
		);
		expect(removeAppImagesScript([])).toBeNull();
	});
});

describe("leftover folders and plans", () => {
	const roots = {
		apps: "/etc/nitrobase/apps",
		gitInspect: "/etc/nitrobase/git-inspect",
	};
	it("recognises only git build and check folders", () => {
		expect(
			isGitWorkDir(
				"/etc/nitrobase/apps/git-1234abcd/build/run-0a1b2c3d",
				roots,
			),
		).toBe(true);
		expect(
			isGitWorkDir(
				"/etc/nitrobase/git-inspect/11111111-2222-4333-8444-555555555555",
				roots,
			),
		).toBe(true);
		for (const dir of [
			"/etc/nitrobase/apps/git-1234abcd",
			"/etc/nitrobase/apps/git-1234abcd/build",
			"/etc/nitrobase/apps/git-1234abcd/build/run-0a1b2c3d/../../..",
			"/etc/nitrobase/apps/../build/run-0a1b2c3d",
			"/etc/nitrobase/git-inspect/..",
			"/etc",
		]) {
			expect(isGitWorkDir(dir, roots), dir).toBe(false);
		}
	});
	it("sweeps by age and removes only valid dead folders", () => {
		const command = gitSweepCommand(roots, 150.2, [
			"/etc/nitrobase/apps/git-1234abcd/build/run-0a1b2c3d",
			"/etc/passwd",
		]);
		expect(command).toContain("-mmin +151");
		expect(command).toContain("-path '*/build/run-*'");
		expect(command).toContain(
			"rm -rf -- '/etc/nitrobase/apps/git-1234abcd/build/run-0a1b2c3d'",
		);
		expect(command).not.toContain("/etc/passwd");
	});
	it("detects secret values in a Railpack plan", () => {
		const plan = JSON.stringify({
			secrets: ["API_KEY"],
			deploy: { variables: {} },
		});
		expect(planHasSecretValue(plan, ["s3cr3t-value"])).toBe(false);
		expect(planHasSecretValue(`${plan}s3cr3t-value`, ["s3cr3t-value"])).toBe(
			true,
		);
	});
	it("detects the prepare placeholder baked into an env section", () => {
		const baked = JSON.stringify({
			secrets: [],
			steps: [
				{
					name: "build",
					variables: { API_KEY: RAILPACK_SECRET_PLACEHOLDER },
				},
			],
			deploy: { variables: { API_KEY: RAILPACK_SECRET_PLACEHOLDER } },
		});
		expect(planHasSecretValue(baked, ["s3cr3t-value"])).toBe(true);
		expect(planHasSecretValue(baked, [])).toBe(true);
	});
});

describe("app images", () => {
	const APP = "11111111-2222-4333-8444-555555555555";

	it("keeps writing today's image labels", () => {
		expect(
			imageLabels({ appId: APP, instanceId: "inst-1", commitSha: "abc" }),
		).toEqual({
			"nitrobase.app": APP,
			"nitrobase.instance": "inst-1",
			"nitrobase.commit": "abc",
		});
	});

	it("reads the app label of an image", () => {
		expect(imageAppLabelCommand("app:x")).toBe(
			`docker image inspect -f '{{index .Config.Labels "nitrobase.app"}}' 'app:x' 2>/dev/null`,
		);
	});

	it("lists the app's images, and fails when Docker fails", () => {
		const root = mkdtempSync(path.join(tmpdir(), "fx-agent-images-"));
		try {
			// Stub `docker`: two images under the app label.
			const docker = path.join(root, "docker");
			writeFileSync(
				docker,
				[
					"#!/bin/sh",
					'[ -n "$FAIL" ] && exit 1',
					'case "$4" in',
					"  label=nitrobase.app=*) echo app:new; echo app:both ;;",
					"esac",
				].join("\n"),
				{ mode: 0o755 },
			);
			const script = appImagesCommand(APP);
			expect(script).toContain(`--filter 'label=nitrobase.app=${APP}'`);
			const env = { ...process.env, PATH: `${root}:/usr/bin:/bin` };
			expect(
				execFileSync("sh", ["-c", script], { encoding: "utf8", env })
					.split("\n")
					.filter(Boolean),
			).toEqual(["app:new", "app:both"]);
			expect(
				spawnSync("sh", ["-c", script], { env: { ...env, FAIL: "1" } }).status,
			).not.toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
