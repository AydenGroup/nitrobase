import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	generateTraefikDynamic,
	servedThroughTunnel,
	traefikAppFileName,
} from "./traefik-dynamic";

const base = {
	appKey: "abc123",
	containerNames: { web: "demo-abc-web", api: "demo-abc-api" },
	certResolver: "letsencrypt",
};

describe("generateTraefikDynamic", () => {
	it("creates redirect + TLS routers with app-scoped names", () => {
		const config = parse(
			generateTraefikDynamic({
				...base,
				routes: [
					{ host: "App.Example.org", service: "web", port: 8080, https: true },
				],
			}),
		);
		expect(config.http.routers["app-abc123-0-http"]).toEqual({
			rule: "Host(`app.example.org`)",
			entryPoints: ["web"],
			middlewares: ["app-abc123-https-redirect"],
			service: "app-abc123-0",
		});
		expect(config.http.routers["app-abc123-0"].tls).toEqual({
			certResolver: "letsencrypt",
		});
		expect(config.http.services["app-abc123-0"].loadBalancer.servers).toEqual([
			{ url: "http://demo-abc-web:8080" },
		]);
	});

	it("supports http-only routes and path prefixes", () => {
		const config = parse(
			generateTraefikDynamic({
				...base,
				routes: [
					{
						host: "a.example.org",
						service: "api",
						port: 3000,
						https: false,
						pathPrefix: "/api",
					},
				],
			}),
		);
		expect(config.http.routers["app-abc123-0"]).toEqual({
			rule: "Host(`a.example.org`) && PathPrefix(`/api`)",
			entryPoints: ["web"],
			service: "app-abc123-0",
		});
		expect(config.http.middlewares).toBeUndefined();
	});

	it.each([
		[
			{ host: "evil`) || Host(`x.org", service: "web", port: 80, https: true },
			/not a valid domain/,
		],
		[
			{ host: "a.example.org", service: "nope", port: 80, https: true },
			/unknown service/,
		],
		[
			{ host: "a.example.org", service: "web", port: 70000, https: true },
			/Invalid port/,
		],
		[
			{
				host: "a.example.org",
				service: "web",
				port: 80,
				https: true,
				pathPrefix: "/`x`",
			},
			/path prefix/,
		],
	])("rejects unsafe input %#", (route, error) => {
		expect(() => generateTraefikDynamic({ ...base, routes: [route] })).toThrow(
			error,
		);
	});

	it("rejects duplicate routes and unsafe app keys", () => {
		const route = {
			host: "a.example.org",
			service: "web",
			port: 80,
			https: true,
		};
		expect(() =>
			generateTraefikDynamic({ ...base, routes: [route, route] }),
		).toThrow(/Duplicate/);
		expect(() => traefikAppFileName("../x")).toThrow();
		expect(traefikAppFileName("abc123")).toBe("app-abc123.yml");
	});

	it("adds a basic-auth middleware to protected routes", () => {
		const user = `supabase:$2b$08$${"a".repeat(53)}`;
		const yaml = generateTraefikDynamic({
			...base,
			routes: [
				{ host: "app.example.org", service: "web", port: 80, https: true },
				{
					host: "studio.example.org",
					service: "api",
					port: 3000,
					https: true,
					basicAuth: [user],
				},
			],
		});
		const config = parse(yaml);
		expect(config.http.middlewares["app-abc123-1-auth"]).toEqual({
			basicAuth: { users: [user], removeHeader: true },
		});
		expect(config.http.routers["app-abc123-1"].middlewares).toEqual([
			"app-abc123-1-auth",
		]);
		// The HTTP router only redirects; the unprotected route has no auth.
		expect(config.http.routers["app-abc123-1-http"].middlewares).toEqual([
			"app-abc123-https-redirect",
		]);
		expect(config.http.routers["app-abc123-0"].middlewares).toBeUndefined();
		expect(yaml).toContain(`- ${user}`);
	});

	it.each([
		[[]],
		[["user:plaintext"]],
		[["a:b:$2b$08$x"]],
		[[`bad user:$2b$08$${"a".repeat(53)}`]],
	])("rejects invalid basic-auth users %j", (users) => {
		expect(() =>
			generateTraefikDynamic({
				...base,
				routes: [
					{
						host: "a.example.org",
						service: "web",
						port: 80,
						https: false,
						basicAuth: users,
					},
				],
			}),
		).toThrow(/basic auth/);
	});

	it("redirects / to a route's root path", () => {
		const yaml = generateTraefikDynamic({
			appKey: "abc123",
			routes: [
				{
					host: "console.example.org",
					service: "s3",
					port: 9001,
					https: true,
					rootRedirect: "/console/",
				},
			],
			containerNames: { s3: "x-s3" },
			certResolver: "le",
		});
		expect(yaml).toContain("redirectRegex:");
		expect(yaml).toContain("replacement: ${1}/console/");
		// Only GET / is redirected (APIs may POST to /).
		expect(yaml).toContain(
			"rule: Host(`console.example.org`) && Path(`/`) && Method(`GET`)",
		);
		const routers = parse(yaml).http.routers as Record<
			string,
			{ middlewares?: string[] }
		>;
		expect(routers["app-abc123-0"].middlewares ?? []).not.toContain(
			"app-abc123-0-root",
		);
		expect(() =>
			generateTraefikDynamic({
				appKey: "abc123",
				routes: [
					{
						host: "c.example.org",
						service: "s3",
						port: 1,
						https: true,
						rootRedirect: "javascript:x",
					},
				],
				containerNames: { s3: "x-s3" },
				certResolver: "le",
			}),
		).toThrow(/root redirect/);
	});
});

describe("Cloudflare Tunnel routes", () => {
	it("serves tunnel hosts only on the unpublished tunnel entrypoint", () => {
		const routes = servedThroughTunnel(
			[
				{ host: "app.example.com", service: "web", port: 80, https: true },
				{
					host: "app.example.com",
					service: "api",
					port: 3000,
					https: true,
					pathPrefix: "/api",
				},
				{ host: "direct.example.com", service: "web", port: 80, https: true },
			],
			new Set(["app.example.com"]),
		);
		const config = parse(
			generateTraefikDynamic({
				appKey: "abc123",
				routes,
				containerNames: { web: "a-web", api: "a-api" },
				certResolver: "letsencrypt",
			}),
		);
		const routers = Object.values(config.http.routers) as {
			rule: string;
			entryPoints: string[];
			tls?: unknown;
			middlewares?: string[];
		}[];
		const tunnel = routers.filter((router) =>
			router.rule.includes("app.example.com"),
		);
		expect(tunnel.length).toBe(2);
		for (const router of tunnel) {
			// Never `web`: the public :80 must not serve a tunnel host.
			expect(router.entryPoints).toEqual(["tunnel"]);
			expect(router.tls).toBeUndefined();
			expect(router.middlewares ?? []).not.toContain(
				"app-abc123-https-redirect",
			);
		}
		const direct = routers.filter((router) =>
			router.rule.includes("direct.example.com"),
		);
		expect(direct.some((router) => router.tls)).toBe(true);
	});
});
