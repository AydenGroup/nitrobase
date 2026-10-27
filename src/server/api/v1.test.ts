import { describe, expect, it, vi } from "vitest";

/** API v1 deploy: a downgrade can be confirmed explicitly (BUG-022). */

const calls = vi.hoisted(() => [] as unknown[]);

vi.mock("#/features/apps/app-jobs.server.ts", () => ({
	startAppAction: async (_actor: unknown, input: unknown) => {
		calls.push(input);
		return { deploymentId: "job-1" };
	},
}));
vi.mock("#/features/apps/apps.server.ts", () => ({
	getAppOverview: async () => null,
	listApps: async () => [],
}));
vi.mock("#/features/backups/jobs.server.ts", () => ({
	startAppBackup: async () => null,
}));
vi.mock("#/features/servers/servers.server.ts", () => ({
	getDeployment: async () => null,
	getServer: async () => null,
	listServers: async () => [],
}));

const { matchApiRoute, openApiDocument } = await import("./v1");

const APP_ID = "00000000-0000-4000-8000-000000000001";

async function deploy(body: unknown) {
	const match = matchApiRoute("POST", `/apps/${APP_ID}/deploy`);
	if (!match || match === "method") throw new Error("no deploy route");
	const { route, params } = match;
	return route.handler({
		actor: {} as never,
		params: route.params.parse(params),
		body: route.body?.parse(body) ?? {},
		request: new Request("http://localhost"),
	});
}

describe("POST /apps/{appId}/deploy", () => {
	it("passes the downgrade confirmation to the update (default: not confirmed)", async () => {
		calls.length = 0;
		await deploy({ version: "2.3.0", confirmDowngrade: true });
		await deploy({ version: "2.5.0" });
		expect(calls).toEqual([
			expect.objectContaining({
				action: "update",
				version: "2.3.0",
				confirmDowngrade: true,
			}),
			expect.objectContaining({
				action: "update",
				version: "2.5.0",
				confirmDowngrade: false,
			}),
		]);
	});

	it("refuses a non-boolean confirmation", async () => {
		await expect(
			deploy({ version: "2.3.0", confirmDowngrade: "yes" }),
		).rejects.toThrow();
	});

	it("documents confirmDowngrade in the OpenAPI document", () => {
		const doc = openApiDocument("https://panel.example.com") as {
			paths: Record<string, Record<string, Record<string, unknown>>>;
		};
		const body = JSON.stringify(
			doc.paths["/apps/{appId}/deploy"]?.post?.requestBody,
		);
		expect(body).toContain('"confirmDowngrade"');
		expect(body).toContain("APP_DOWNGRADE_UNCONFIRMED");
	});
});
