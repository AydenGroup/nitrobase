import { describe, expect, it } from "vitest";
import { restartPolicyOf } from "#/config/restart-policies.ts";
import { transformCompose } from "./compose-transform";
import {
	applyDefaultRestart,
	completionTargets,
	declaredRestart,
	oneShotServices,
	oneShotServicesOf,
	optionalServicesOf,
	resolvedRestart,
	restartPolicyPending,
} from "./restart";

// Appwrite 2.6.1 declares no restart policy for these (BUG-015).
const compose = `
services:
  appwrite:
    image: appwrite/appwrite
    depends_on:
      migrate: { condition: service_completed_successfully }
  appwrite-worker:
    image: appwrite/appwrite
    restart: unless-stopped
  postgresql:
    image: postgres
  migrate:
    image: appwrite/appwrite
  seed:
    image: busybox
    restart: "no"
  retry:
    image: busybox
    restart: on-failure:3
  swarm:
    image: busybox
    deploy:
      restart_policy: { condition: none }
`;

const transform = (keep?: string[]) =>
	transformCompose(compose, {
		appId: "app-1",
		folder: "aw-1a2b3c4d",
		appRoot: "/etc/nitrobase/apps/aw-1a2b3c4d",
		network: "nitrobase-network",
		proxiedServices: [],
		defaultRestart: { policy: "unless-stopped", keep },
	}).compose.services as Record<string, { restart?: string }>;

describe("default restart policy (BUG-015)", () => {
	it("gives services without a policy the default", () => {
		const services = transform();
		expect(services.appwrite.restart).toBe("unless-stopped");
		expect(services.postgresql.restart).toBe("unless-stopped");
	});

	it("keeps explicit policies, one-shot jobs and template opt-outs", () => {
		const services = transform(["postgresql"]);
		expect(services["appwrite-worker"].restart).toBe("unless-stopped");
		expect(services.seed.restart).toBe("no");
		expect(services.retry.restart).toBe("on-failure:3");
		expect(services.swarm.restart).toBeUndefined();
		// Waited on to finish: restarting it would loop forever.
		expect(services.migrate.restart).toBeUndefined();
		expect(services.postgresql.restart).toBeUndefined();
	});

	it("adds nothing when the default is off", () => {
		const services = { web: {} as Record<string, unknown> };
		expect(applyDefaultRestart(services, undefined)).toEqual([]);
		expect(services.web.restart).toBeUndefined();
	});

	it("reads declared policies", () => {
		expect(restartPolicyOf("on-failure:5")).toBe("on-failure");
		expect(restartPolicyOf(false)).toBe("no");
		expect(restartPolicyOf("sometimes")).toBeUndefined();
		expect(declaredRestart({ restart: "always" })).toBe("always");
		expect(declaredRestart({ restart: "sometimes" })).toBe("no");
		expect(
			declaredRestart({ deploy: { restart_policy: { condition: "any" } } }),
		).toBe("always");
		expect(declaredRestart({ image: "x" })).toBeUndefined();
	});

	it("tells one-shot services from the ones expected to run", () => {
		const services = transform();
		expect(completionTargets(services)).toEqual(new Set(["migrate"]));
		expect([...oneShotServices(services)].sort()).toEqual([
			"migrate",
			"retry",
			"seed",
			"swarm",
		]);
		// From the deployed compose text (monitoring, app status).
		expect([...oneShotServicesOf(compose)].sort()).toEqual([
			"appwrite",
			"migrate",
			"postgresql",
			"retry",
			"seed",
			"swarm",
		]);
		expect(oneShotServicesOf("services: [")).toEqual(new Set());
		expect(oneShotServicesOf(null)).toEqual(new Set());
	});
});

describe("restart policy inherited through extends", () => {
	const extending = `
services:
  base-job:
    image: busybox
    restart: "no"
  job:
    extends: base-job
  nightly:
    extends: { service: job }
  base-web:
    image: nginx
  web:
    extends: { service: base-web }
  loop-a:
    extends: loop-b
  loop-b:
    extends: loop-a
`;
	const run = () =>
		transformCompose(extending, {
			appId: "app-1",
			folder: "ex-1a2b3c4d",
			appRoot: "/etc/nitrobase/apps/ex-1a2b3c4d",
			network: "nitrobase-network",
			proxiedServices: [],
			defaultRestart: { policy: "unless-stopped" },
		}).compose as { services: Record<string, { restart?: string }> };

	it("keeps a one-shot parent's policy for its children", () => {
		const { services } = run();
		expect(services.job.restart).toBeUndefined();
		expect(services.nightly.restart).toBeUndefined();
		expect(resolvedRestart(services, "nightly")).toBe("no");
	});

	it("still gives long-running chains the default, and survives cycles", () => {
		const { services } = run();
		expect(services["base-web"].restart).toBe("unless-stopped");
		expect(services.web.restart).toBe("unless-stopped");
		expect(services["loop-a"].restart).toBe("unless-stopped");
	});

	it("counts inherited one-shot policies as one-shot", () => {
		expect([...oneShotServicesOf(run())].sort()).toEqual([
			"base-job",
			"job",
			"nightly",
		]);
	});
});

describe("deployed compose files", () => {
	it("finds services a reboot would leave stopped until a redeploy", () => {
		// Deployed before the default existed: what upstream declared.
		expect(restartPolicyPending(compose, "unless-stopped")).toEqual([
			"appwrite",
			"postgresql",
		]);
		expect(
			restartPolicyPending(compose, "unless-stopped", ["postgresql"]),
		).toEqual(["appwrite"]);
		// Deployed with it, or with the default off: nothing to do.
		const deployed = transformCompose(compose, {
			appId: "app-1",
			folder: "aw-1a2b3c4d",
			appRoot: "/etc/nitrobase/apps/aw-1a2b3c4d",
			network: "nitrobase-network",
			proxiedServices: [],
			defaultRestart: { policy: "unless-stopped" },
		}).yaml;
		expect(restartPolicyPending(deployed, "unless-stopped")).toEqual([]);
		expect(restartPolicyPending(compose, undefined)).toEqual([]);
		expect(restartPolicyPending(null, "unless-stopped")).toEqual([]);
	});

	it("knows services that may have no container", () => {
		expect(
			optionalServicesOf(`
services:
  web: { image: nginx }
  debug: { image: busybox, profiles: [debug] }
  spare: { image: nginx, scale: 0 }
  standby: { image: nginx, deploy: { replicas: 0 } }
`),
		).toEqual(new Set(["debug", "spare", "standby"]));
	});
});
