import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Logs read through the API (`readAppLogs`): the app's secret values are
 * masked by the real masker, and only the newest APP_LOGS_API_MAX_BYTES
 * come back. Only the SSH executor and the app row are stubbed.
 */

const state = vi.hoisted(() => ({
	stdout: "",
	stderr: "",
	commands: [] as unknown[],
	closed: 0,
	maxBytes: 1024,
}));

vi.mock("#/config/server.ts", () => ({
	getConfig: () => ({
		APP_LOGS_TAIL_DEFAULT: 200,
		APP_LOGS_TAIL_MAX: 5000,
		APP_LOGS_API_MAX_BYTES: state.maxBytes,
	}),
}));
vi.mock("#/features/apps/apps.server.ts", () => ({
	getAppRow: async () => ({ id: "app-1", folder: "blog-1" }),
	getAppServer: async () => ({ id: "server-1" }),
	appLocation: () => ({
		folder: "blog-1",
		appRoot: "/opt/nitrobase/apps/blog-1",
		appId: "app-1",
	}),
	deployedServices: () => ["web", "db"],
	appSecretValues: async () => ["hunter2-password", "tok_abcdefgh"],
}));
vi.mock("#/features/servers/servers.server.ts", () => ({
	getExecutor: async () => ({
		exec: async (command: unknown) => {
			state.commands.push(command);
			return { stdout: state.stdout, stderr: state.stderr, exitCode: 0 };
		},
		close: () => {
			state.closed++;
		},
	}),
}));
vi.mock("#/features/auth/sessions.server.ts", () => ({
	liveConnectionOf: () => null,
	liveSessionSignal: () => ({ signal: undefined, release: () => {} }),
}));

const { readAppLogs, lastBytes } = await import("./logs.server");

const actor = { teamId: "t-1" } as never;

beforeEach(() => {
	state.stdout = "";
	state.stderr = "";
	state.commands = [];
	state.closed = 0;
	state.maxBytes = 1024;
});

describe("readAppLogs", () => {
	it("masks the app's secret values in stdout and stderr", async () => {
		state.stdout = "web-1 | connecting with hunter2-password\nweb-1 | ready\n";
		state.stderr = "db-1 | auth tok_abcdefgh failed\n";
		const result = await readAppLogs(actor, { appId: "app-1", tail: 10 });
		expect(result.text).not.toContain("hunter2-password");
		expect(result.text).not.toContain("tok_abcdefgh");
		expect(result.text).toContain("web-1 | connecting with ••••••");
		expect(result.text).toContain("db-1 | auth •••••• failed");
		expect(result).toMatchObject({ service: null, tail: 10, truncated: false });
		expect(state.closed).toBe(1);
	});

	it("keeps only the newest bytes, from a whole line, and says so", async () => {
		state.maxBytes = 40;
		state.stdout = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		const result = await readAppLogs(actor, { appId: "app-1" });
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(40);
		expect(result.text.endsWith("line 19")).toBe(true);
		expect(result.text.split("\n")[0]).toMatch(/^line \d+$/);
		expect(result.text).not.toContain("line 0\n");
	});

	it("bounds the tail by the instance maximum", async () => {
		const result = await readAppLogs(actor, { appId: "app-1", tail: 999_999 });
		expect(result.tail).toBe(5000);
	});

	it("refuses a service the app does not run", async () => {
		await expect(
			readAppLogs(actor, { appId: "app-1", service: "cache" }),
		).rejects.toMatchObject({ code: "APP_SERVICE_NOT_FOUND" });
		expect(state.commands).toEqual([]);
	});
});

describe("lastBytes", () => {
	it("leaves short text alone", () => {
		expect(lastBytes("a\nb", 10)).toEqual({ text: "a\nb", truncated: false });
	});

	it("counts bytes, not characters", () => {
		// Two-byte characters: 5 bytes would hold "abc" plus a split one.
		const twoBytes = String.fromCodePoint(0xe9);
		const { text, truncated } = lastBytes(`${twoBytes.repeat(5)}\nabc`, 5);
		expect(truncated).toBe(true);
		expect(text).toBe("abc");
	});
});
