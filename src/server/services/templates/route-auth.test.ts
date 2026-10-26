import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { bcryptHasher, withPathRoutes, withRouteAuth } from "./route-auth";

const manifest = {
	domains: [
		{ service: "kong", port: 8000, primary: true, https: true, paths: [] },
		{
			service: "studio",
			port: 3000,
			primary: false,
			https: true,
			paths: [],
			basic_auth: {
				username: "DASHBOARD_USERNAME",
				password: "DASHBOARD_PASSWORD",
			},
		},
	],
};
const routes = [
	{ host: "a.example.org", service: "kong", port: 8000, https: true },
	{ host: "studio.a.example.org", service: "studio", port: 3000, https: true },
	{ host: "other.example.org", service: "studio", port: 3000, https: true },
];
const values = { DASHBOARD_USERNAME: "supabase", DASHBOARD_PASSWORD: "s3cret" };

describe("withRouteAuth", () => {
	it("protects every route of the service with the template's credentials", () => {
		const out = withRouteAuth(routes, manifest, values, (p) => `hash(${p})`);
		expect(out[0].basicAuth).toBeUndefined();
		expect(out[1].basicAuth).toEqual(["supabase:hash(s3cret)"]);
		expect(out[2].basicAuth).toEqual(["supabase:hash(s3cret)"]);
	});

	it("refuses to route a protected service without credentials", () => {
		expect(() =>
			withRouteAuth(routes, manifest, { DASHBOARD_USERNAME: "x" }, (p) => p),
		).toThrow(/needs/);
		expect(() =>
			withRouteAuth(
				routes,
				manifest,
				{ ...values, DASHBOARD_USERNAME: "a:b" },
				(p) => p,
			),
		).toThrow();
	});

	it("hashes with bcrypt that verifies", () => {
		const hash = bcryptHasher(4)("s3cret");
		expect(hash).toMatch(/^\$2[aby]\$04\$/);
		expect(bcrypt.compareSync("s3cret", hash)).toBe(true);
	});
});

describe("withPathRoutes", () => {
	it("adds the template's path routes on every host of the service", () => {
		const out = withPathRoutes(
			[
				{ host: "a.example.org", service: "console", port: 3000, https: true },
				{ host: "b.example.org", service: "console", port: 3000, https: false },
				{ host: "x.example.org", service: "other", port: 1, https: true },
			],
			{
				domains: [
					{
						service: "console",
						port: 3000,
						primary: true,
						https: true,
						paths: [
							{ prefix: "/v1", service: "api", port: 80 },
							{ prefix: "/v1/realtime", service: "realtime", port: 80 },
						],
					},
				],
			},
		);
		expect(
			out.map((r) => `${r.host}${r.pathPrefix ?? ""}>${r.service}:${r.https}`),
		).toEqual([
			"a.example.org>console:true",
			"a.example.org/v1>api:true",
			"a.example.org/v1/realtime>realtime:true",
			"b.example.org>console:false",
			"b.example.org/v1>api:false",
			"b.example.org/v1/realtime>realtime:false",
			"x.example.org>other:true",
		]);
	});
});
