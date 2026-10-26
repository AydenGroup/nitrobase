import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A new app is rendered before its row is stored (BUG-005): a version the
 * first deploy would refuse fails the request and leaves no ERROR app.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const TEAM = "00000000-0000-4000-8000-0000000000aa";
const SERVER = "00000000-0000-4000-8000-0000000000ab";
const state = vi.hoisted(() => ({
	transactions: 0,
	rendered: [] as Record<string, unknown>[],
	refuse: true,
}));

vi.mock("#/db/index.ts", () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => [
						{ id: SERVER, teamId: TEAM, status: "ready", tunnelOnly: false },
					],
				}),
			}),
		}),
		transaction: async () => {
			state.transactions++;
			return { id: "new-app" };
		},
	},
}));

vi.mock("#/features/templates/templates.server.ts", async () => {
	const { TemplateError } = await import(
		"#/server/services/templates/naming.ts"
	);
	return {
		getTemplateManifest: async () => ({
			id: "demo",
			source: { type: "github" },
			security: {
				privileged: false,
				host_network: false,
				host_pid: false,
				docker_socket: false,
				cap_add: [],
				devices: [],
				security_opt: [],
				host_paths: [],
				external: [],
			},
			advanced: false,
			variables: {},
			domains: [],
		}),
		getTemplateVersions: async () => ({ versions: [], defaultRef: "v2.0.0" }),
		dryRenderNewApp: async (input: Record<string, unknown>) => {
			state.rendered.push(input);
			if (state.refuse) {
				throw new TemplateError("TEMPLATE_VERSION_NOT_OFFERED", {
					version: String(input.version),
				});
			}
			return null;
		},
	};
});

vi.mock("./sources.server", () => ({
	prepareCreate: async ({ template }: { template: unknown }) => ({
		manifest: template,
	}),
}));

const { createAppRecord } = await import("./apps.server");
const { withImplied } = await import("#/config/permissions.ts");

const actor = {
	userId: null,
	teamId: TEAM,
	role: null,
	permissions: new Set(withImplied(["app.deploy"])),
	instanceAdmin: false,
	via: "token" as const,
	tokenId: "t1",
} as never;

const input = {
	templateId: "demo",
	serverId: SERVER,
	name: "Demo",
	version: "v1.0.0",
	inputs: {},
	acknowledged: false,
};

beforeEach(() => {
	state.transactions = 0;
	state.rendered = [];
	state.refuse = true;
});

describe("createAppRecord with dryRender", () => {
	it("refuses before storing anything when the render fails", async () => {
		await expect(
			createAppRecord(actor, input, { dryRender: true }),
		).rejects.toMatchObject({ code: "TEMPLATE_VERSION_NOT_OFFERED" });
		expect(state.transactions).toBe(0);
		expect(state.rendered[0]).toMatchObject({
			templateId: "demo",
			version: "v1.0.0",
			name: "Demo",
		});
	});

	it("stores the app once the render passes", async () => {
		state.refuse = false;
		await createAppRecord(actor, input, { dryRender: true });
		expect(state.transactions).toBe(1);
	});

	it("does not render for callers that did not ask (restore, import)", async () => {
		await createAppRecord(actor, input);
		expect(state.rendered).toEqual([]);
		expect(state.transactions).toBe(1);
	});
});
