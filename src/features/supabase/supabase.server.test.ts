import { describe, expect, it, vi } from "vitest";

vi.mock("#/db/index.ts", () => ({ db: {} }));
vi.mock("#/features/apps/apps.server.ts", () => ({}));
vi.mock("#/features/servers/servers.server.ts", () => ({}));

const { gatewayAuthHeaders, newKeysState } = await import("./supabase.server");

const config = {
	anon_key: "ANON_KEY",
	service_key: "SERVICE_ROLE_KEY",
	publishable_key: "SUPABASE_PUBLISHABLE_KEY",
	secret_key: "SUPABASE_SECRET_KEY",
};
const legacy = {
	ANON_KEY: "eyJ.anon.sig",
	SERVICE_ROLE_KEY: "eyJ.service.sig",
};
const opaque = {
	SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abc_12345678",
	SUPABASE_SECRET_KEY: "sb_secret_abc_12345678",
};

describe("gatewayAuthHeaders", () => {
	it("prefers the new opaque keys, in apikey only", () => {
		const values = { ...legacy, ...opaque };
		expect(gatewayAuthHeaders(config, values, "service")).toEqual({
			apikey: opaque.SUPABASE_SECRET_KEY,
		});
		expect(gatewayAuthHeaders(config, values, "anon")).toEqual({
			apikey: opaque.SUPABASE_PUBLISHABLE_KEY,
		});
	});

	it("falls back to the legacy JWT keys (also as bearer token)", () => {
		// Upstream's empty defaults before the redeploy that generates them.
		const values = {
			...legacy,
			SUPABASE_PUBLISHABLE_KEY: "",
			SUPABASE_SECRET_KEY: "",
		};
		expect(gatewayAuthHeaders(config, values, "service")).toEqual({
			apikey: legacy.SERVICE_ROLE_KEY,
			Authorization: `Bearer ${legacy.SERVICE_ROLE_KEY}`,
		});
		const withoutNewConfig = {
			anon_key: "ANON_KEY",
			service_key: "SERVICE_ROLE_KEY",
		};
		expect(
			gatewayAuthHeaders(withoutNewConfig, { ...legacy, ...opaque }, "anon"),
		).toEqual({
			apikey: legacy.ANON_KEY,
			Authorization: `Bearer ${legacy.ANON_KEY}`,
		});
	});

	it("returns null without keys (not deployed yet)", () => {
		expect(gatewayAuthHeaders(config, {}, "service")).toBeNull();
	});
});

describe("newKeysState", () => {
	const manifest = {
		variables: {
			SUPABASE_PUBLISHABLE_KEY: { min_version: "v1.26.04" },
			SUPABASE_SECRET_KEY: { min_version: "v1.26.04" },
		},
	} as never;

	it("is ready when the app has both keys", () => {
		expect(
			newKeysState(config, { ...legacy, ...opaque }, manifest, "v1.26.08"),
		).toEqual({ state: "ready", minVersion: "v1.26.04" });
	});

	it("asks for a redeploy on a release that has them", () => {
		expect(
			newKeysState(
				config,
				{ ...legacy, SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_SECRET_KEY: "" },
				manifest,
				"v1.26.08",
			).state,
		).toBe("redeploy");
	});

	it("asks for an update on an older release", () => {
		expect(newKeysState(config, legacy, manifest, "v1.26.03")).toEqual({
			state: "update",
			minVersion: "v1.26.04",
		});
	});

	it("is unsupported when the template does not define them", () => {
		expect(
			newKeysState(config, legacy, { variables: {} } as never, "v1.26.08")
				.state,
		).toBe("unsupported");
		expect(
			newKeysState(
				{ publishable_key: undefined, secret_key: undefined },
				legacy,
				manifest,
				"v1.26.08",
			).state,
		).toBe("unsupported");
	});
});
