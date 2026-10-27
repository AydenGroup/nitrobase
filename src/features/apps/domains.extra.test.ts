import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Additional domains on a service the template limits (`[[domains]]
 * extra_domains`, BUG-021: Appwrite's console only accepts sign-ins from
 * its primary domain). `addDomain` runs for real against an in-memory
 * domain list; the database, routes job and checks are faked.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const REASON = "Console sign-in only works on the primary domain.";

const state = vi.hoisted(() => ({
	domains: [] as Record<string, unknown>[],
	extra: { policy: "warn", reason: "" } as { policy: string; reason: string },
	audits: [] as string[],
}));

vi.mock("#/config/server.ts", () => ({
	getConfig: () => ({
		DOMAIN_CHECK_TIMEOUT_MS: 1000,
		CERT_EXPIRY_WARNING_DAYS: 14,
		DOMAIN_RECHECK_DELAY_MS: 1_000_000_000,
	}),
}));

vi.mock("#/server/services/audit.ts", () => ({
	audit: (event: { action: string }) => state.audits.push(event.action),
}));

vi.mock("#/db/index.ts", () => {
	const chain = (result: () => unknown) => {
		const node: Record<string, unknown> = {};
		for (const name of ["from", "where", "set", "values"]) {
			node[name] = () => node;
		}
		node.limit = async () => result();
		node.returning = async () => result();
		// biome-ignore lint/suspicious/noThenProperty: a thenable query
		node.then = (resolve: (value: unknown) => unknown) => resolve(result());
		return node;
	};
	return {
		db: {
			// The "host taken" lookup: never taken in these tests.
			select: () => chain(() => []),
			insert: () => {
				let row: Record<string, unknown> = {};
				const node = chain(() => [row]);
				node.values = (values: Record<string, unknown>) => {
					row = { id: `d${state.domains.length + 1}`, checks: {}, ...values };
					state.domains.push(row);
					return node;
				};
				return node;
			},
			update: () => chain(() => []),
		},
	};
});

vi.mock("#/features/deployments/deployments.server.ts", () => ({
	withAppServerLock: (_app: unknown, run: () => unknown) => run(),
	onServerIdle: () => {},
}));

vi.mock("./app-jobs.server", () => ({
	startRoutesJob: async () => ({ deploymentId: "job-1" }),
}));

vi.mock("./apps.server", () => ({
	assertHostAvailable: async () => {},
	deployedServices: () => ["appwrite", "appwrite-console"],
	getAppRow: async () => ({ id: "app-1", serverId: "srv" }),
	// Tunnel-only server: no DNS check right after adding.
	getAppServer: async () => ({ tunnelOnly: true, tunnelEnabled: true }),
	listAppDomains: async () => state.domains,
	resolveServerIps: async () => [],
	getAppManifest: async () => ({
		domains: [
			{
				service: "appwrite-console",
				port: 3000,
				primary: true,
				paths: [],
				https: true,
				extra_domains: state.extra,
			},
		],
	}),
}));

const { addDomain } = await import("./domains.server");

const actor = { teamId: "team-1" } as never;
const add = (host: string, service = "appwrite-console", port = 3000) =>
	addDomain(actor, {
		appId: "00000000-0000-4000-8000-000000000001",
		host,
		service,
		port,
		https: true,
		viaTunnel: false,
	});

beforeEach(() => {
	state.domains = [];
	state.audits = [];
	state.extra = { policy: "warn", reason: REASON };
});

describe("additional domains limited by the template (BUG-021)", () => {
	it("never limits the first (primary) domain", async () => {
		const result = await add("aw.example.com");
		expect(result.domain.primary).toBe(true);
		expect(result.limitation).toBeNull();
	});

	it("adds an additional domain with the template's reason", async () => {
		await add("aw.example.com");
		const result = await add("console.example.org");
		expect(result.domain.host).toBe("console.example.org");
		expect(result.limitation).toEqual({
			code: "DOMAIN_EXTRA_LIMITED",
			params: {
				service: "appwrite-console",
				port: "3000",
				reason: { $template: REASON },
			},
			text: null,
		});
	});

	it("does not limit other services or ports", async () => {
		await add("aw.example.com");
		expect(
			(await add("api.example.org", "appwrite", 80)).limitation,
		).toBeNull();
	});

	it("refuses an additional domain when the policy says so", async () => {
		state.extra = { policy: "refuse", reason: REASON };
		await add("aw.example.com");
		await expect(add("console.example.org")).rejects.toMatchObject({
			code: "DOMAIN_EXTRA_REFUSED",
			params: { service: "appwrite-console", port: "3000" },
		});
		expect(state.domains.map((domain) => domain.host)).toEqual([
			"aw.example.com",
		]);
		expect(state.audits).toEqual(["app.domain.add"]);
	});
});
