import { describe, expect, it } from "vitest";
import { analyzeCustomCompose } from "./custom-compose";

const ctx = {
	folder: "custom-compose-00000000",
	appRoot: "/etc/nitrobase/apps/custom-compose-00000000",
	network: "nitrobase-network",
};

describe("analyzeCustomCompose", () => {
	it("lists services with their container ports, volumes and missing env", () => {
		const result = analyzeCustomCompose(
			`services:
  web:
    image: nginx
    ports: ["8080:80", "127.0.0.1:8443:443/tcp", {target: 9000, published: 9}]
    expose: ["3000"]
    environment:
      - A=\${A}
      - B=\${B:-x}
      - C=$\${LITERAL}
    volumes: [data:/data]
  worker:
    image: busybox
volumes:
  data:
`,
			"A=1\n",
			ctx,
		);
		expect(result.error).toBeNull();
		expect(result.services).toEqual([
			{ name: "web", image: "nginx", ports: [80, 443, 3000, 9000] },
			{ name: "worker", image: "busybox", ports: [] },
		]);
		expect(result.volumes).toEqual(["data"]);
		expect(result.missingEnv).toEqual([]);
		expect(
			result.warnings.some((w) => w.code === "COMPOSE_WARN_PORTS_REMOVED"),
		).toBe(true);
	});

	it("reports unset variables and policy refusals", () => {
		expect(
			analyzeCustomCompose("services:\n  a:\n    image: x:${TAG}\n", "", ctx)
				.missingEnv,
		).toEqual(["TAG"]);
		for (const bad of [
			"services:\n  a:\n    image: x\n    privileged: true\n",
			"services:\n  a:\n    image: x\n    volumes: [/var/run/docker.sock:/s]\n",
			"services:\n  a:\n    image: x\n    network_mode: host\n",
			"services:\n  a:\n    image: x\n    cap_add: [SYS_ADMIN]\n",
			"services:\n  a:\n    image: x\n    volumes: [/:/host]\n",
			"include: [other.yml]\nservices:\n  a:\n    image: x\n",
		]) {
			expect(analyzeCustomCompose(bad, "", ctx).error).toBeTruthy();
		}
		expect(analyzeCustomCompose("not: [yaml", "", ctx).error).toBeTruthy();
		expect(analyzeCustomCompose("services: {}", "", ctx).error?.code).toBe(
			"COMPOSE_NO_SERVICES",
		);
	});

	it("shows the restart policy a deploy adds (BUG-015)", () => {
		const compose =
			'services:\n  web:\n    image: nginx\n  init:\n    image: busybox\n    restart: "no"\n  db:\n    image: postgres\n    restart: always\n';
		const warning = (defaultRestart?: "unless-stopped") =>
			analyzeCustomCompose(compose, "", {
				...ctx,
				defaultRestart,
			}).warnings.find((item) => item.code === "COMPOSE_WARN_RESTART_DEFAULT");
		expect(warning("unless-stopped")?.params).toEqual({
			services: { $list: ["web"] },
			policy: "unless-stopped",
		});
		expect(warning()).toBeUndefined();
	});
});
