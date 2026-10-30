import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "canary-secret-value-123";
const APP_ID = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
	secrets: [] as string[],
	output: "",
}));

vi.mock("#/features/apps/apps.server.ts", () => ({
	appLocation: () => ({}),
	appSecretValues: async () => state.secrets,
	deployedServices: () => ["web"],
	getAppRow: async () => ({ folder: "app-folder" }),
	getAppServer: async () => ({}),
}));
vi.mock("#/features/auth/sessions.server.ts", () => ({
	liveConnectionOf: () => ({}),
	liveSessionSignal: (_connection: unknown, signal: AbortSignal) => ({
		signal,
		release: () => undefined,
	}),
}));
vi.mock("#/features/servers/servers.server.ts", () => ({
	getExecutor: async () => ({
		close: () => undefined,
		exec: async (
			_command: string,
			options?: { onStdout?: (chunk: string) => void },
		) => {
			options?.onStdout?.(state.output);
			return {
				stdout: options?.onStdout ? "" : state.output,
				stderr: "",
				exitCode: 0,
			};
		},
	}),
}));
vi.mock("#/server/services/apps/commands.ts", () => ({
	composeLogsCommand: () => "docker compose logs",
}));

const { appLogsResponse } = await import("./logs.server.ts");

const actor = {} as Parameters<typeof appLogsResponse>[0];
const ask = (query: string) =>
	appLogsResponse(
		actor,
		"user-1",
		APP_ID,
		new Request(`http://localhost/api/apps/${APP_ID}/logs?${query}`),
	);

beforeEach(() => {
	state.secrets = [SECRET];
	state.output = `boot api=${SECRET}\nready\n`;
});

describe("container logs", () => {
	it("masks the app's secret values in the downloaded file", async () => {
		const text = await (await ask("download=1")).text();
		expect(text).not.toContain(SECRET);
		expect(text).toContain("boot api=");
		expect(text).toContain("ready");
	});

	it("masks the app's secret values in the live stream", async () => {
		const response = await ask("tail=10");
		const text = await response.text();
		expect(text).not.toContain(SECRET);
		expect(text).toContain("boot api=");
		expect(text).toContain("ready");
	});

	it("leaves the logs alone when the app has no secret values", async () => {
		state.secrets = [];
		const text = await (await ask("download=1")).text();
		expect(text).toContain(`boot api=${SECRET}`);
	});
});
