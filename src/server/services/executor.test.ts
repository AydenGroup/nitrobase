import { describe, expect, it } from "vitest";
import {
	assertManagedPath,
	clampTerminalSize,
	killTaggedCommand,
	managedReadScript,
	managedWriteScript,
	PATH_ESCAPE_EXIT,
	shellQuote,
	withRemoteTimeout,
} from "./executor";

describe("assertManagedPath", () => {
	it("accepts normalized paths under /etc/nitrobase", () => {
		expect(assertManagedPath("/etc/nitrobase/traefik/traefik.yml")).toBe(
			"/etc/nitrobase/traefik/traefik.yml",
		);
	});

	it.each([
		"/etc/nitrobase/../root/.ssh/authorized_keys",
		"/etc/nitrobase/apps/../../passwd",
		"/etc/nitrobase",
		"/etc/nitrobase-evil/x",
		"/etc/nitrobase//x",
		"etc/nitrobase/x",
		"/tmp/x",
	])("rejects %s", (value) => {
		expect(() => assertManagedPath(value)).toThrow();
	});
});

describe("shellQuote", () => {
	it("wraps in single quotes and escapes embedded quotes", () => {
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
		expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
	});
});

describe("clampTerminalSize", () => {
	it("clamps and defaults", () => {
		expect(clampTerminalSize({})).toEqual({ cols: 80, rows: 24 });
		expect(clampTerminalSize({ cols: 1, rows: 1000 })).toEqual({
			cols: 10,
			rows: 200,
		});
	});
});

describe("managed file scripts", () => {
	it("write script refuses symlinked parents and replaces the target entry", () => {
		const script = managedWriteScript("/etc/nitrobase/apps/a/x.yml");
		expect(script).toContain(`realpath -m -- "$dir"`);
		expect(script).toContain(`exit ${PATH_ESCAPE_EXIT}`);
		expect(script).toContain('mv -fT -- "$tmp" "$target"');
		expect(script).toContain("dir='/etc/nitrobase/apps/a'");
	});

	it("read script requires the resolved path to equal the requested one", () => {
		const script = managedReadScript("/etc/nitrobase/apps/a/x.yml");
		expect(script).toContain(`realpath -e -- "$target"`);
		expect(script).toContain('[ -f "$target" ]');
	});

	it("both reject paths outside the root before generating a script", () => {
		expect(() => managedWriteScript("/etc/passwd")).toThrow();
		expect(() => managedReadScript("/etc/nitrobase/../shadow")).toThrow();
	});

	it("quotes hostile file names", () => {
		const script = managedWriteScript("/etc/nitrobase/apps/a/$(reboot)'x");
		expect(script).toContain(`target='/etc/nitrobase/apps/a/$(reboot)'\\''x'`);
	});
});

describe("withRemoteTimeout", () => {
	it("tags the command so it can be killed from another channel", () => {
		const wrapped = withRemoteTimeout("sleep 1", 1000, "abcdef0123456789");
		expect(wrapped).toContain(
			"sh -c ': nitrobase-job-abcdef0123456789; sleep 1'",
		);
		expect(killTaggedCommand("abcdef0123456789", "TERM")).toBe(
			"pkill -TERM -f 'nitrobase-job-abcdef0123456789' || true",
		);
		expect(() => killTaggedCommand("bad tag;", "KILL")).toThrow();
	});

	it("wraps in GNU timeout with a process-group kill and a fallback", () => {
		const wrapped = withRemoteTimeout("echo 'hi'", 1500);
		expect(wrapped).toContain("timeout --kill-after=10s 2s sh -c");
		expect(wrapped).toContain(`'echo '\\''hi'\\'''`);
		expect(wrapped).toContain("else exec sh -c");
	});
});
