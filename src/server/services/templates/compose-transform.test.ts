import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_NAME } from "#/config/shared.ts";
import { assertSafeCompose } from "./compose-policy";
import {
	type ComposeTransformContext,
	transformCompose,
} from "./compose-transform";

const ctx = (
	overrides: Partial<ComposeTransformContext> = {},
): ComposeTransformContext => ({
	appId: "app-1",
	folder: "demo-1a2b3c4d",
	appRoot: "/etc/nitrobase/apps/demo-1a2b3c4d",
	network: "nitrobase-network",
	proxiedServices: ["web"],
	...overrides,
});

type Svc = Record<string, any>;
const run = (yaml: string, c = ctx()) => {
	const result = transformCompose(yaml, c);
	return {
		...result,
		services: result.compose.services as Record<string, Svc>,
	};
};

describe("transformCompose", () => {
	const base = `
name: upstream
services:
  web:
    image: nginx
    container_name: upstream-web
    ports: ["8080:80", "\${PORT}:443"]
    expose: ["80"]
    labels: ["a=1"]
    depends_on: [db]
    links: ["db:database"]
  db:
    image: postgres
    volumes:
      - ./data/db:/var/lib/postgresql/data:Z
      - dbconf:/etc/postgresql
      - /tmp
volumes:
  dbconf:
  shared:
    name: shared-data
`;

	it("sets project/container names, strips ports, adds labels", () => {
		const { compose, services, containerNames, warnings } = run(base);
		expect(compose.name).toBe("demo-1a2b3c4d");
		expect(services.web.container_name).toBe("demo-1a2b3c4d-web");
		expect(containerNames).toEqual({
			web: "demo-1a2b3c4d-web",
			db: "demo-1a2b3c4d-db",
		});
		expect(services.web.ports).toBeUndefined();
		expect(services.web.expose).toEqual(["80"]);
		expect(services.web.labels).toEqual({
			a: "1",
			"nitrobase.app": "app-1",
			"nitrobase.service": "web",
			"nitrobase.routed": "true",
		});
		expect(services.web.depends_on).toEqual(["db"]);
		expect(services.web.links).toEqual(["db:database"]);
		expect(warnings.some((w) => w.code === "COMPOSE_WARN_PORTS_REMOVED")).toBe(
			true,
		);
	});

	it("never names the proxy network: routed services are attached after up by container name (BUG-006)", () => {
		const { compose, services, networkAttachments } = run(base);
		// Compose would register the service name (`web`) there too.
		expect(services.web.networks).toEqual({
			default: { aliases: ["upstream-web"] },
		});
		expect(services.db.networks).toEqual({ default: {} });
		expect(compose.networks).toBeUndefined();
		expect(services.web.labels["nitrobase.routed"]).toBe("true");
		expect(services.db.labels["nitrobase.routed"]).toBeUndefined();
		expect(networkAttachments).toEqual([
			{ container: "demo-1a2b3c4d-web", network: "nitrobase-network" },
		]);
	});

	it("lists database link networks as attachments, not in the compose file", () => {
		const link = {
			key: "nitrobase_link_0123456789abcdef0123456789abcdef",
			name: "nitrobase-link-0123456789abcdef0123456789abcdef",
		};
		const { compose, services, networkAttachments } = run(
			base,
			ctx({ linkNetworks: [{ ...link, services: ["db"] }] }),
		);
		expect(Object.keys(services.db.networks)).toEqual(["default"]);
		expect(compose.networks).toBeUndefined();
		expect(networkAttachments).toEqual([
			{ container: "demo-1a2b3c4d-web", network: "nitrobase-network" },
			{ container: "demo-1a2b3c4d-db", network: link.name },
		]);
		// A template naming a link network or the proxy network is refused.
		expect(() =>
			run(
				`services:\n  web: { image: x }\nnetworks:\n  ${link.key}: { external: true, name: ${link.name} }\n`,
			),
		).toThrow(/reserved|External networks/);
		expect(() =>
			run(
				"services:\n  web: { image: x, networks: [shared] }\nnetworks:\n  shared: { external: true, name: nitrobase-network }\n",
				ctx({ allow: { external: ["nitrobase-network"] } }),
			),
		).toThrow(/reserved/);
	});

	it("pins relative mounts inside the app folder and prefixes explicit names", () => {
		const { compose, services } = run(base);
		expect(services.db.volumes).toEqual([
			"/etc/nitrobase/apps/demo-1a2b3c4d/data/db:/var/lib/postgresql/data:Z",
			"dbconf:/etc/postgresql",
			"/tmp",
		]);
		expect((compose.volumes as Svc).shared).toEqual({
			name: "demo-1a2b3c4d_shared-data",
			labels: { "nitrobase.app": "app-1" },
		});
		expect((compose.volumes as Svc).dbconf).toEqual({
			labels: { "nitrobase.app": "app-1" },
		});
	});

	it("labels every named volume with the app, external ones excepted", () => {
		const yaml =
			"services:\n  web: { image: x, volumes: ['new:/b', 'cur:/c', 'named:/g', 'ext:/e'] }\nvolumes:\n  new: {}\n  cur: { labels: { keep: '1' } }\n  named: { name: data }\n  ext: { external: true }\n";
		const { compose } = run(yaml, ctx({ allow: { external: ["ext"] } }));
		const volumes = compose.volumes as Svc;
		expect(volumes.new).toEqual({ labels: { "nitrobase.app": "app-1" } });
		expect(volumes.cur).toEqual({
			labels: { keep: "1", "nitrobase.app": "app-1" },
		});
		expect(volumes.named).toEqual({
			name: "demo-1a2b3c4d_data",
			labels: { "nitrobase.app": "app-1" },
		});
		expect(volumes.ext).toEqual({ external: true });
	});

	it("produces valid YAML that round-trips", () => {
		const { yaml, compose } = run(base);
		expect(parse(yaml)).toEqual(compose);
	});

	it.each([
		["privileged", "privileged: true", /privileged/],
		["host network", "network_mode: host", /network_mode: host/],
		["host pid", "pid: host", /pid: host/],
		["cap_add", "cap_add: [NET_ADMIN]", /cap_add/],
		["devices", "devices: ['/dev/kvm:/dev/kvm']", /devices/],
		["security_opt", "security_opt: ['seccomp:unconfined']", /security_opt/],
		[
			"docker socket",
			"volumes: ['/var/run/docker.sock:/var/run/docker.sock']",
			/Docker socket/,
		],
		["host path", "volumes: ['/root:/host']", /outside the app folder/],
		["escape", "volumes: ['../../etc:/etc2']", /escapes the app folder/],
		["home", "volumes: ['~/x:/x']", /home-relative/],
		["variable source", "volumes: ['${HOME}:/x']", /must not use variables/],
		["external_links", "external_links: [other]", /external_links/],
		[
			"remote build",
			"build: { context: 'https://evil.example/repo.git' }",
			/remote build/,
		],
		["env_file escape", "env_file: ['../../secret.env']", /escapes/],
		[
			"long bind syntax",
			"volumes: [{ type: bind, source: /etc, target: /x }]",
			/outside the app folder/,
		],
	])("rejects %s by default", (_label, line, error) => {
		const yaml = `services:\n  web:\n    image: x\n    ${line}\n`;
		expect(() => run(yaml)).toThrow(error);
	});

	it("reports a Docker socket bind before the settings that come with it", () => {
		const refusal = (yaml: string, c = ctx({ proxiedServices: [] })) => {
			try {
				run(yaml, c);
			} catch (error) {
				return error;
			}
			return null;
		};
		// Upstream Supabase <= v1.26.05 (`vector`): socket by variable + label=disable.
		const vector = `services:
  vector:
    image: timberio/vector
    privileged: true
    security_opt: ["label=disable"]
    volumes:
      - \${DOCKER_SOCKET_LOCATION}:/var/run/docker.sock:ro,z
`;
		expect(refusal(vector)).toMatchObject({
			name: "ComposePolicyError",
			code: "COMPOSE_DOCKER_SOCKET",
			params: { service: "vector" },
		});
		expect(
			refusal(
				"services:\n  w:\n    image: x\n    security_opt: [a]\n    volumes: [{ type: bind, source: /var/run/docker.sock, target: /s }]\n",
			),
		).toMatchObject({ code: "COMPOSE_DOCKER_SOCKET" });
		// Allowed socket: the next refusal is the next blocked setting.
		expect(
			refusal(
				vector,
				ctx({
					proxiedServices: [],
					allow: { dockerSocket: true, privileged: true },
				}),
			),
		).toMatchObject({
			code: "COMPOSE_NOT_ALLOWED",
			params: { setting: "security_opt: label=disable" },
		});
		// A socket path inside the app folder is not the host's socket.
		expect(
			refusal(
				"services:\n  w:\n    image: x\n    volumes: ['./run/docker.sock:/var/run/docker.sock']\n",
			),
		).toBeNull();
	});

	it("allows dangerous options only when allowlisted, with warnings", () => {
		const yaml = `services:
  web:
    image: x
    privileged: true
    cap_add: [NET_ADMIN]
    volumes: ['/var/run/docker.sock:/var/run/docker.sock:ro', '/srv/media:/media']
`;
		const { warnings } = run(
			yaml,
			ctx({
				allow: {
					privileged: true,
					capAdd: ["NET_ADMIN"],
					dockerSocket: true,
					hostPaths: ["/srv/media"],
				},
			}),
		);
		const text = JSON.stringify(warnings);
		expect(text).toMatch(/COMPOSE_WARN_PRIVILEGED/);
		expect(text).toMatch(/NET_ADMIN/);
		expect(text).toMatch(/docker.sock/);
		expect(text).toMatch(/\/srv\/media/);
	});

	it("rejects external resources unless allowlisted", () => {
		const yaml = `services:
  web: { image: x }
volumes:
  data: { external: true, name: prod-data }
`;
		expect(() => run(yaml)).toThrow(/External volumes prod-data/);
		expect(() =>
			run(yaml, ctx({ allow: { external: ["prod-data"] } })),
		).not.toThrow();
	});

	it("rewrites network_mode container:<name> to the in-app service", () => {
		const yaml = `services:
  web: { image: x }
  vpn: { image: y, container_name: my-vpn }
  sidecar: { image: z, network_mode: "container:my-vpn" }
`;
		const { services } = run(yaml);
		expect(services.sidecar.network_mode).toBe("service:vpn");
		expect(services.sidecar.networks).toBeUndefined();
		expect(() =>
			run(
				`services:\n  web: { image: x }\n  s: { image: z, network_mode: "container:other-app" }\n`,
			),
		).toThrow(/must reference a service in this app/);
	});

	it("rejects undeclared named volumes, reserved network names and unknown routed services", () => {
		expect(() =>
			run("services:\n  web: { image: x, volumes: ['undeclared:/x'] }\n"),
		).toThrow(/not declared/);
		expect(() =>
			run("services:\n  web: { image: x, networks: [nitrobase_proxy] }\n"),
		).toThrow(/reserved/);
		expect(() => run("services:\n  api: { image: x }\n")).toThrow(
			/Routed service web/,
		);
	});

	it("reserves the panel's networks, labels and files", () => {
		for (const yaml of [
			"services:\n  web: { image: x, networks: [nitrobase_proxy] }\n",
			"services:\n  web: { image: x, networks: [nitrobase_link_0123456789abcdef0123456789abcdef] }\n",
			"services:\n  web: { image: x }\nnetworks:\n  nitrobase_proxy: {}\n",
			"services:\n  web: { image: x }\nnetworks:\n  nitrobase_link_0123456789abcdef0123456789abcdef: {}\n",
		]) {
			expect(() => run(yaml), yaml).toThrow(/reserved/);
		}
		for (const source of ["./.nitrobase-instance", "./.nitrobase-networks"]) {
			expect(() =>
				run(`services:\n  web:\n    image: x\n    volumes: ["${source}:/x"]\n`),
			).toThrow(new RegExp(`managed by ${APP_NAME}`));
		}
		// Panel labels are stripped; the panel's own are written.
		const { services, warnings } = run(
			'services:\n  web:\n    image: x\n    labels:\n      nitrobase.app: other\n      nitrobase.instance: other\n      nitrobase.link: x\n      keep: "1"\n',
			ctx({ instanceId: "inst-1" }),
		);
		expect(services.web.labels).toEqual({
			keep: "1",
			"nitrobase.app": "app-1",
			"nitrobase.service": "web",
			"nitrobase.instance": "inst-1",
			"nitrobase.routed": "true",
		});
		expect(
			warnings.find((w) => w.code === "COMPOSE_WARN_LABELS_REMOVED")?.params,
		).toEqual({
			service: "web",
			count: 3,
			prefixes: { $list: ["nitrobase.*"] },
		});
	});

	it("strips the panel's labels in any case, like the policy refuses them", () => {
		const { services } = run(
			"services:\n  web:\n    image: x\n    labels:\n      NitroBase.note: a\n      NITROBASE.x: b\n      Traefik.keep: c\n",
		);
		expect(services.web.labels).toEqual({
			// Docker's prefixes stay case-sensitive, as before.
			"Traefik.keep": "c",
			"nitrobase.app": "app-1",
			"nitrobase.service": "web",
			"nitrobase.routed": "true",
		});
	});

	it("refuses panel labels on top-level networks, not on volumes", () => {
		for (const labels of [
			"{ nitrobase.instance: inst-1, nitrobase.link: x }",
			"{ NitroBase.link: x }",
			'["nitrobase.instance=inst-1"]',
		]) {
			expect(
				() =>
					run(
						`services:\n  web: { image: x, networks: [n] }\nnetworks:\n  n:\n    labels: ${labels}\n`,
					),
				labels,
			).toThrow(/Network n: label .* is reserved/);
		}
		// Volume labels are left as they are (changing them recreates it).
		const { compose } = run(
			"services:\n  web: { image: x, volumes: ['v:/v'] }\nvolumes:\n  v:\n    labels: { nitrobase.note: a }\n",
		);
		expect((compose.volumes as Svc).v.labels).toEqual({
			"nitrobase.note": "a",
			"nitrobase.app": "app-1",
		});
	});

	it("keeps existing network aliases and merges container_name aliases", () => {
		const yaml = `services:
  web:
    image: x
    container_name: legacy
    networks:
      default:
        aliases: [api-gw]
`;
		const { services } = run(yaml);
		expect(services.web.networks.default.aliases).toEqual(["api-gw", "legacy"]);
	});

	it("gives two instances of the same template disjoint names", () => {
		const a = run(
			base,
			ctx({
				folder: "demo-aaaaaaaa",
				appRoot: "/etc/nitrobase/apps/demo-aaaaaaaa",
			}),
		);
		const b = run(
			base,
			ctx({
				folder: "demo-bbbbbbbb",
				appRoot: "/etc/nitrobase/apps/demo-bbbbbbbb",
			}),
		);
		expect(a.compose.name).not.toBe(b.compose.name);
		expect(a.services.web.container_name).not.toBe(
			b.services.web.container_name,
		);
		expect((a.compose.volumes as Svc).shared.name).not.toBe(
			(b.compose.volumes as Svc).shared.name,
		);
	});

	describe("reviewer bypasses", () => {
		const svc = (body: string) => `services:\n  web:\n    image: x\n${body}`;
		it.each([
			[
				"C-1 privileged via interpolation",
				'    privileged: "${P:-true}"\n',
				/privileged/,
			],
			["C-1 pid via interpolation", '    pid: "${X:-host}"\n', /pid/],
			["C-1 ipc via interpolation", '    ipc: "${X:-host}"\n', /ipc/],
			[
				"C-1 userns via interpolation",
				'    userns_mode: "${X:-host}"\n',
				/userns_mode/,
			],
			[
				"C-1 env_file via interpolation",
				'    env_file: "${E:-/etc/shadow}"\n',
				/env_file/,
			],
			[
				"C-1 build context via interpolation",
				'    build:\n      context: "${C:-/}"\n',
				/build.context/,
			],
			[
				"C-1 dockerfile escape",
				"    build:\n      context: .\n      dockerfile: ../../../etc/Dockerfile\n",
				/dockerfile/,
			],
			[
				"C-1 cap_add via interpolation",
				'    cap_add: ["${CAP:-SYS_ADMIN}"]\n',
				/cap_add/,
			],
			[
				"C-1 label key via interpolation",
				'    labels: { "${L:-traefik.enable}": "true" }\n',
				/labels/,
			],
			["C-2 traefik router label (stripped)", "", null],
			[
				"C-3 pid container",
				'    pid: "container:other-app-db"\n',
				/pid: container/,
			],
			[
				"C-3 ipc container",
				'    ipc: "container:other-app-db"\n',
				/ipc: container/,
			],
			[
				"C-4 device_cgroup_rules",
				'    device_cgroup_rules: ["b *:* rwm"]\n',
				/device_cgroup_rules/,
			],
			["C-4 cgroup_parent", "    cgroup_parent: /\n", /cgroup_parent/],
			["C-4 runtime", "    runtime: runc\n", /runtime/],
			["C-4 sysctls", "    sysctls: { kernel.x: 1 }\n", /sysctls/],
			[
				"C-4 oom_kill_disable",
				"    oom_kill_disable: true\n",
				/oom_kill_disable/,
			],
			["C-4 isolation", "    isolation: process\n", /isolation/],
			["C-4 privileged as string", '    privileged: "yes"\n', /privileged/],
			[
				"C-4 build ssh",
				"    build:\n      context: .\n      ssh: [default]\n",
				/build.ssh/,
			],
			[
				"C-4 build host network",
				"    build:\n      context: .\n      network: host\n",
				/build.network/,
			],
			["C-4 use_api_socket", "    use_api_socket: true\n", /use_api_socket/],
			["C-4 provider", "    provider: { type: x }\n", /provider/],
			[
				"C-4 privileged hook",
				"    post_start: [{ command: id, privileged: true }]\n",
				/lifecycle/,
			],
			[
				"C-7 bridge network",
				"    network_mode: bridge\n",
				/network_mode: bridge/,
			],
		])("%s", (_label, body, error) => {
			if (error === null) return;
			expect(() => run(svc(body))).toThrow(error);
		});

		it("C-1 rejects interpolated secrets/configs files", () => {
			expect(() =>
				run(
					`${svc("")}secrets:\n  k:\n    file: "\${F:-/root/.ssh/id_ed25519}"\n`,
				),
			).toThrow(/file/);
			expect(() =>
				run(`${svc("")}configs:\n  k:\n    file: /etc/passwd\n`),
			).toThrow(/outside the app folder/);
		});

		it("C-2 strips traefik and com.docker labels", () => {
			const { services, warnings } = run(
				svc(
					'    labels:\n      traefik.enable: "true"\n      traefik.http.routers.x.rule: "Host(`other.example.com`)"\n      com.docker.compose.project: other\n      keep: "1"\n',
				),
			);
			expect(services.web.labels).toEqual({
				keep: "1",
				"nitrobase.app": "app-1",
				"nitrobase.service": "web",
				"nitrobase.routed": "true",
			});
			expect(
				warnings.filter((w) => w.code?.startsWith("COMPOSE_WARN_LABEL")),
			).toEqual([
				{
					code: "COMPOSE_WARN_LABELS_REMOVED",
					params: {
						service: "web",
						count: 3,
						prefixes: { $list: ["traefik.*", "com.docker.*"] },
					},
					text: null,
				},
			]);
		});

		it("C-3 rewrites namespaces of in-app containers to service:", () => {
			const { services } = run(`services:
  web: { image: x, container_name: legacy-web }
  side: { image: y, pid: "container:legacy-web", ipc: "container:legacy-web" }
`);
			expect(services.side.pid).toBe("service:web");
			expect(services.side.ipc).toBe("service:web");
		});

		it("C-5 applies YAML merge keys before checking", () => {
			expect(() =>
				run(`x-priv: &priv
  privileged: true
services:
  web:
    image: x
    <<: *priv
`),
			).toThrow(/privileged/);
		});

		it("C-5 caps alias expansion", () => {
			const lines = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
			for (let i = 0; i < 12; i++) {
				const prev = String.fromCharCode(97 + i);
				const next = String.fromCharCode(98 + i);
				lines.push(
					`${next}: &${next} [*${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}]`,
				);
			}
			lines.push("services:\n  web: { image: x }");
			expect(() => run(lines.join("\n"))).toThrow();
		});
	});

	it("publishes only owner-enabled ports and the policy enforces them", () => {
		const yaml = `
services:
  web:
    image: nginx
  pooler:
    image: supavisor
    ports: ["5432:5432", "6543:6543"]
`;
		const enabled = ctx({
			publishedPorts: [{ service: "pooler", target: 5432, published: 15432 }],
		});
		const { services } = run(yaml, enabled);
		expect(services.pooler.ports).toEqual(["15432:5432/tcp"]);
		expect(services.web.ports).toBeUndefined();
		expect(run(yaml).services.pooler.ports).toBeUndefined();

		// Resolved (long syntax) models are checked against the same allowlist.
		const resolved = (ports: unknown[]) => ({
			name: "demo-1a2b3c4d",
			services: {
				pooler: {
					image: "supavisor",
					container_name: "demo-1a2b3c4d-pooler",
					labels: { "nitrobase.app": "app-1" },
					ports,
				},
			},
		});
		const ok = {
			mode: "ingress",
			target: 5432,
			published: "15432",
			protocol: "tcp",
		};
		expect(() =>
			assertSafeCompose(
				resolved([ok]),
				{ ...enabled, proxiedServices: [] },
				"resolved",
			),
		).not.toThrow();
		for (const bad of [
			{ ...ok, published: "5432" },
			{ ...ok, host_ip: "127.0.0.2" },
			{ ...ok, protocol: "udp" },
			{ ...ok, mode: "host" },
			"15432:5432/udp",
		]) {
			expect(() =>
				assertSafeCompose(
					resolved([bad]),
					{ ...enabled, proxiedServices: [] },
					"resolved",
				),
			).toThrow(/not enabled/);
		}
		expect(() =>
			assertSafeCompose(
				resolved([ok]),
				{ ...ctx(), proxiedServices: [] },
				"resolved",
			),
		).toThrow(/not enabled/);
	});

	it("binds a loopback-only port on 127.0.0.1 and never wider", () => {
		const yaml = `
services:
  web:
    image: nginx
  pooler:
    image: supavisor
`;
		const loopback = ctx({
			publishedPorts: [
				{ service: "pooler", target: 5432, published: 15432, loopback: true },
			],
		});
		expect(run(yaml, loopback).services.pooler.ports).toEqual([
			"127.0.0.1:15432:5432/tcp",
		]);
		const resolved = (port: Record<string, unknown>) => ({
			name: "demo-1a2b3c4d",
			services: {
				pooler: {
					image: "supavisor",
					container_name: "demo-1a2b3c4d-pooler",
					labels: { "nitrobase.app": "app-1" },
					ports: [port],
				},
			},
		});
		const port = { target: 5432, published: "15432", protocol: "tcp" };
		const check = (entry: Record<string, unknown>) => () =>
			assertSafeCompose(
				resolved(entry),
				{ ...loopback, proxiedServices: [] },
				"resolved",
			);
		expect(check({ ...port, host_ip: "127.0.0.1" })).not.toThrow();
		// A loopback port may not be widened to every interface.
		expect(check(port)).toThrow(/not enabled/);
		expect(check({ ...port, host_ip: "0.0.0.0" })).toThrow(/not enabled/);
	});

	it("refuses mounting the app folder itself or the panel's own files", () => {
		for (const source of [
			"./",
			".",
			"./.env",
			"./custom.env",
			"./service-env/x.env",
			"./docker-compose.yml",
		]) {
			expect(() =>
				run(
					`services:\n  web:\n    image: x\n    volumes: ["${source}:/app"]\n`,
				),
			).toThrow(new RegExp(`app folder itself|managed by ${APP_NAME}`));
		}
		expect(() =>
			run(
				'services:\n  web:\n    image: x\n    volumes: ["./data:/app", "./conf/.env:/e"]\n',
			),
		).not.toThrow();
	});

	it("refuses host paths above the app folder, even when allowlisted, and volume devices on it", () => {
		const allow = { hostPaths: ["/etc/nitrobase", "/"] };
		for (const source of ["/etc/nitrobase", "/etc/nitrobase/apps", "/"]) {
			expect(() =>
				run(
					`services:\n  web:\n    image: x\n    volumes: ["${source}:/h"]\n`,
					ctx({ allow }),
				),
			).toThrow(/contains the app folder/);
		}
		expect(() =>
			run(
				"services:\n  web:\n    image: x\n    volumes: [v:/d]\nvolumes:\n  v:\n    driver_opts: {type: none, o: bind, device: /etc/nitrobase/apps/demo-1a2b3c4d}\n",
			),
		).toThrow(/app folder itself/);
		expect(() =>
			run(
				"services:\n  web:\n    image: x\n    volumes: [v:/d]\nvolumes:\n  v:\n    driver_opts: {type: none, o: bind, device: /etc/nitrobase/apps/demo-1a2b3c4d/.env}\n",
			),
		).toThrow(new RegExp(`managed by ${APP_NAME}`));
	});
});
