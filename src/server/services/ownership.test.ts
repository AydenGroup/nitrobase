import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	claimServerScript,
	evaluateServerOwnership,
	readMarkerSnippet,
	serverOwnershipScript,
	writeMarkerScript,
} from "./ownership";

describe("server ownership", () => {
	it("detects another instance on the root marker or Traefik label", () => {
		expect(
			evaluateServerOwnership({ root_owner: "-", traefik_owner: "" }, "me"),
		).toEqual({ foreign: [], claimed: false });
		expect(
			evaluateServerOwnership({ root_owner: "me", traefik_owner: "me" }, "me"),
		).toEqual({ foreign: [], claimed: true });
		expect(
			evaluateServerOwnership(
				{ root_owner: "other", traefik_owner: "other" },
				"me",
			),
		).toEqual({ foreign: ["other"], claimed: false });
		expect(
			evaluateServerOwnership({ root_owner: "me", traefik_owner: "x" }, "me"),
		).toEqual({ foreign: ["x"], claimed: true });
	});

	it("probes the root marker and the Traefik label", () => {
		const lines = serverOwnershipScript(
			"/etc/nitrobase",
			"nitrobase-traefik",
		).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(
			/^echo "root_owner=.*'\/etc\/nitrobase\/instance-id'/,
		);
		expect(lines[0]).toContain("[ ! -L '/etc/nitrobase/instance-id' ]");
		expect(lines[1]).toMatch(/^echo "traefik_owner=.*'nitrobase-traefik'/);
		expect(lines[1]).toContain(
			`'{{index .Config.Labels "nitrobase.instance"}}'`,
		);
	});

	it("reads a marker, never through a symlink", () => {
		const root = mkdtempSync(path.join(tmpdir(), "fx-agent-marker-"));
		try {
			const a = path.join(root, "a");
			const sh = () =>
				execFileSync("sh", ["-c", readMarkerSnippet(`'${a}'`)], {
					encoding: "utf8",
				}).trim();
			expect(sh()).toBe("-");
			writeFileSync(path.join(root, "t"), "linked\n");
			symlinkSync(path.join(root, "t"), a);
			expect(sh()).toBe("-");
			rmSync(a);
			writeFileSync(a, "new\n");
			expect(sh()).toBe("new");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes markers atomically and only into existing folders", () => {
		const script = writeMarkerScript(
			"/etc/nitrobase/apps/a-1/.nitrobase-instance",
			"me",
		);
		expect(script.startsWith("(")).toBe(true);
		expect(script).toContain("|| exit 0");
		expect(script).toContain("mv -fT --");
		expect(() => writeMarkerScript("/x", "bad id; rm")).toThrow();
		const claim = claimServerScript(
			"/etc/nitrobase",
			"/etc/nitrobase/apps",
			["pocketbase-1a2b3c4d"],
			"me",
		);
		expect(claim).toContain("'/etc/nitrobase/instance-id'");
		expect(claim).toContain(
			"'/etc/nitrobase/apps/pocketbase-1a2b3c4d/.nitrobase-instance'",
		);
		expect(claim).not.toContain("rm -f");
	});
});
