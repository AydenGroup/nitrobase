import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertSafeCompose,
	type ComposePolicyContext,
	hasInterpolation,
	isTruthy,
} from "./compose-policy";

const fixture = (name: string) =>
	JSON.parse(
		readFileSync(
			path.join(__dirname, "__fixtures__", `${name}-resolved.json`),
			"utf8",
		),
	);

const ctxFor = (template: string, proxied: string[]): ComposePolicyContext => ({
	appId: "0123abcd-0000-4000-8000-000000000000",
	folder: `${template}-0123abcd`,
	appRoot: `/etc/nitrobase/apps/${template}-0123abcd`,
	network: "nitrobase-network",
	proxiedServices: proxied,
});

describe("assertSafeCompose (resolved `docker compose config` output)", () => {
	it("accepts the rendered shipped templates", () => {
		expect(() =>
			assertSafeCompose(
				fixture("supabase"),
				ctxFor("supabase", ["kong"]),
				"resolved",
			),
		).not.toThrow();
		expect(() =>
			assertSafeCompose(
				fixture("pocketbase"),
				ctxFor("pocketbase", ["pocketbase"]),
				"resolved",
			),
		).not.toThrow();
	});

	it.each([
		[
			"privileged after interpolation",
			(c: any) => {
				c.services.kong.privileged = true;
			},
			/privileged/,
		],
		[
			"host pid after interpolation",
			(c: any) => {
				c.services.kong.pid = "host";
			},
			/pid: host/,
		],
		[
			"bind outside app",
			(c: any) => {
				c.services.kong.volumes.push({
					type: "bind",
					source: "/root/.ssh",
					target: "/x",
				});
			},
			/outside the app folder/,
		],
		[
			"env_file outside app",
			(c: any) => {
				c.services.kong.env_file = [{ path: "/etc/shadow" }];
			},
			/env_file/,
		],
		[
			"the proxy network on a service (even a routed one)",
			(c: any) => {
				c.services.kong.networks.nitrobase_proxy = null;
			},
			/reserved/,
		],
		[
			"the proxy network declared",
			(c: any) => {
				c.networks.shared = { name: "nitrobase-network", external: true };
			},
			/reserved/,
		],
		[
			"a link network on a service",
			(c: any) => {
				c.services.db.networks.nitrobase_link_0123456789abcdef0123456789abcdef =
					null;
			},
			/reserved for database links/,
		],
		[
			"the proxy network by name",
			(c: any) => {
				c.networks.shared = { name: "nitrobase-network", external: true };
			},
			/reserved/,
		],
		[
			"a link network declared by Docker name",
			(c: any) => {
				c.networks.l = {
					name: "nitrobase-link-0123456789abcdef0123456789abcdef",
					external: true,
				};
			},
			/reserved/,
		],
		[
			"a panel label in another case",
			(c: any) => {
				c.services.kong.labels["NitroBase.app"] = "other";
			},
			/NitroBase.app/,
		],
		[
			"a panel label on a top-level network",
			(c: any) => {
				c.networks.n = {
					labels: { "nitrobase.instance": "inst-1", "nitrobase.link": "x" },
				};
			},
			/Network n: label nitrobase.instance is reserved/,
		],
		[
			"a panel label of either case on a top-level network",
			(c: any) => {
				c.networks.n = { labels: ["NitroBase.link=x"] };
			},
			/Network n: label NitroBase.link is reserved/,
		],
		[
			"a panel label the transform never writes",
			(c: any) => {
				c.services.kong.labels["nitrobase.link"] = "x";
			},
			/nitrobase.link/,
		],
		[
			"a routed label on an unrouted service",
			(c: any) => {
				c.services.db.labels["nitrobase.routed"] = "true";
			},
			/nitrobase.routed/,
		],
		[
			"a routed service without its label",
			(c: any) => {
				delete c.services.kong.labels["nitrobase.routed"];
			},
			/nitrobase.routed/,
		],
		[
			"traefik label",
			(c: any) => {
				c.services.kong.labels["traefik.enable"] = "true";
			},
			/reserved/,
		],
		[
			"renamed container",
			(c: any) => {
				c.services.kong.container_name = "supabase-kong";
			},
			/container_name/,
		],
		[
			"external volume",
			(c: any) => {
				c.volumes.x = { name: "prod", external: true };
			},
			/External volumes/,
		],
		[
			"project renamed",
			(c: any) => {
				c.name = "other";
			},
			/project name/,
		],
	])("rejects %s", (_label, mutate, error) => {
		const compose = fixture("supabase");
		mutate(compose);
		expect(() =>
			assertSafeCompose(compose, ctxFor("supabase", ["kong"]), "resolved"),
		).toThrow(error);
	});

	it("reports a Docker socket bind before security_opt", () => {
		const compose = fixture("supabase");
		compose.services.kong.security_opt = ["label=disable"];
		compose.services.kong.volumes.push({
			type: "bind",
			source: "/var/run/docker.sock",
			target: "/var/run/docker.sock",
		});
		expect(() =>
			assertSafeCompose(compose, ctxFor("supabase", ["kong"]), "resolved"),
		).toThrow(
			expect.objectContaining({
				name: "ComposePolicyError",
				code: "COMPOSE_DOCKER_SOCKET",
			}),
		);
	});
});

describe("helpers", () => {
	it("detects interpolation but not escaped dollars", () => {
		expect(hasInterpolation("${X}")).toBe(true);
		expect(hasInterpolation("$X")).toBe(true);
		expect(hasInterpolation("$$X")).toBe(false);
		expect(hasInterpolation("plain")).toBe(false);
	});

	it("treats yaml-ish truthy strings as true", () => {
		for (const value of [true, "true", "yes", "on", "1", 1])
			expect(isTruthy(value)).toBe(true);
		for (const value of [false, undefined, "false", "no", "off", "0", 0]) {
			expect(isTruthy(value)).toBe(false);
		}
	});
});
