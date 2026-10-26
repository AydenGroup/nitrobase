import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DOCKERFILE_SYMLINK_EXIT,
	finalizeScript,
	parseProbeOutput,
	SUBDIR_ESCAPE_EXIT,
	SUBDIR_MISSING_EXIT,
} from "./commands";

/**
 * The finalize script runs for real here (POSIX sh) on a scratch checkout:
 * paths it accepts are later read by Docker on the host, so a symlink on
 * the Dockerfile path or as the build folder must stop the build.
 */
let dirs: string[] = [];
function workspace(): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-finalize-")));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function run(dir: string, subdir: string, dockerfile = "Dockerfile") {
	const result = spawnSync(
		"sh",
		[
			"-c",
			`set -eu\ncd "$WS"\n${finalizeScript(dir)}`,
			"sb",
			"0",
			subdir,
			dockerfile,
		],
		{ env: { ...process.env, WS: dir }, encoding: "utf8" },
	);
	return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("finalize script", () => {
	it("probes a regular Dockerfile", () => {
		const dir = workspace();
		writeFileSync(path.join(dir, "Dockerfile"), "FROM x\nEXPOSE 8080\n");
		const result = run(dir, "");
		expect(result.code).toBe(0);
		expect(parseProbeOutput(result.out).contents.Dockerfile).toBe(
			"FROM x\nEXPOSE 8080\n",
		);
	});

	it("refuses a Dockerfile that is a symlink (to a host file, or dangling)", () => {
		const dir = workspace();
		symlinkSync("/etc/hosts", path.join(dir, "Dockerfile"));
		expect(run(dir, "").code).toBe(DOCKERFILE_SYMLINK_EXIT);
		const other = workspace();
		symlinkSync(
			"../../../root/.ssh/id_ed25519",
			path.join(other, "Dockerfile"),
		);
		expect(run(other, "").code).toBe(DOCKERFILE_SYMLINK_EXIT);
	});

	it("refuses a symlink anywhere on the Dockerfile path", () => {
		const dir = workspace();
		symlinkSync("/etc", path.join(dir, "docker"));
		expect(run(dir, "", "docker/hosts").code).toBe(DOCKERFILE_SYMLINK_EXIT);
		const inner = workspace();
		mkdirSync(path.join(inner, "real"));
		symlinkSync("real", path.join(inner, "alias"));
		writeFileSync(path.join(inner, "real", "Dockerfile"), "FROM x\n");
		expect(run(inner, "", "alias/Dockerfile").code).toBe(
			DOCKERFILE_SYMLINK_EXIT,
		);
	});

	it("deletes symlinked .dockerignore files", () => {
		const dir = workspace();
		writeFileSync(path.join(dir, "Dockerfile"), "FROM x\n");
		symlinkSync("/etc/hosts", path.join(dir, ".dockerignore"));
		symlinkSync("/etc/hosts", path.join(dir, "Dockerfile.dockerignore"));
		expect(run(dir, "").code).toBe(0);
		expect(existsSync(path.join(dir, ".dockerignore"))).toBe(false);
		expect(() =>
			lstatSync(path.join(dir, "Dockerfile.dockerignore")),
		).toThrow();
	});

	it("refuses a build folder that is a symlink or missing", () => {
		const dir = workspace();
		symlinkSync("/etc", path.join(dir, "web"));
		expect(run(dir, "web").code).toBe(SUBDIR_ESCAPE_EXIT);
		const inner = workspace();
		mkdirSync(path.join(inner, "real"));
		symlinkSync("real", path.join(inner, "web"));
		expect(run(inner, "web").code).toBe(SUBDIR_ESCAPE_EXIT);
		expect(run(workspace(), "nope").code).toBe(SUBDIR_MISSING_EXIT);
	});

	it("accepts a real build folder with a nested Dockerfile", () => {
		const dir = workspace();
		mkdirSync(path.join(dir, "apps", "web", "docker"), { recursive: true });
		writeFileSync(
			path.join(dir, "apps", "web", "docker", "Dockerfile"),
			"FROM y\n",
		);
		const result = run(dir, "apps/web", "docker/Dockerfile");
		expect(result.code).toBe(0);
		expect(parseProbeOutput(result.out).contents["docker/Dockerfile"]).toBe(
			"FROM y\n",
		);
	});
});
