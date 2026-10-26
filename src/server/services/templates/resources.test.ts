import { describe, expect, it } from "vitest";
import { transformCompose } from "./compose-transform";
import {
	applyResources,
	assertResources,
	effectiveLimits,
	evaluateOvercommit,
	mergeResources,
	parseMemoryBytes,
} from "./resources";

describe("resource limits", () => {
	it("writes deploy.resources and drops conflicting service-level limits", () => {
		const svc: Record<string, unknown> = {
			image: "x",
			mem_limit: "1g",
			cpus: 2,
			deploy: { resources: { reservations: { devices: [] } } },
		};
		applyResources(svc, { memoryMb: 512, cpus: 0.5, memoryReservationMb: 64 });
		expect(svc.mem_limit).toBeUndefined();
		expect(svc.cpus).toBeUndefined();
		expect(svc.deploy).toEqual({
			resources: {
				limits: { memory: "512M", cpus: "0.5" },
				reservations: { devices: [], memory: "64M" },
			},
		});
		expect(effectiveLimits(svc)).toEqual({ memoryMb: 512, cpus: 0.5 });
	});

	it("keeps upstream limits when Nitrobase sets none", () => {
		const svc: Record<string, unknown> = { mem_limit: "256m" };
		applyResources(svc, { memoryMb: null, cpus: null });
		expect(svc).toEqual({ mem_limit: "256m" });
		expect(effectiveLimits(svc).memoryMb).toBe(256);
	});

	it("parses compose memory values", () => {
		expect(parseMemoryBytes("512M")).toBe(512 * 1024 * 1024);
		expect(parseMemoryBytes("1g")).toBe(1024 ** 3);
		expect(parseMemoryBytes("134217728")).toBe(134217728);
		expect(parseMemoryBytes(1024)).toBe(1024);
		expect(parseMemoryBytes("lots")).toBeNull();
	});

	it("merges template defaults with app overrides (null removes)", () => {
		expect(
			mergeResources(
				["web", "db", "cache"],
				{ web: { memoryMb: 512 }, db: { memoryMb: 1024, cpus: 1 } },
				{ web: { memoryMb: 256 }, db: { memoryMb: null } },
			),
		).toEqual({
			web: { memoryMb: 256, memoryReservationMb: null, cpus: null },
			db: { memoryMb: null, memoryReservationMb: null, cpus: 1 },
		});
	});

	it("policy refuses a compose that lost or loosened a limit", () => {
		expect(() =>
			assertResources(
				{ web: { deploy: { resources: { limits: { memory: "1G" } } } } },
				{ web: { memoryMb: 512 } },
			),
		).toThrow(/memory limit/);
		expect(() => assertResources({ web: {} }, { web: { cpus: 1 } })).toThrow(
			/CPU limit/,
		);
		expect(() =>
			assertResources(
				{ web: { deploy: { resources: { limits: { memory: "536870912" } } } } },
				{ web: { memoryMb: 512 } },
			),
		).not.toThrow();
	});

	it("flags overcommit against RAM and cores", () => {
		const result = evaluateOvercommit(
			{ memoryMb: 3000, cpus: 1.5 },
			{ memoryMb: 2048, cpus: 2 },
			100,
		);
		expect(result.memory.over).toBe(true);
		expect(result.cpus.over).toBe(false);
		expect(
			evaluateOvercommit(
				{ memoryMb: 10, cpus: 1 },
				{ memoryMb: null, cpus: null },
				100,
			).memory.over,
		).toBe(false);
	});

	it("is applied by the compose transform, with owner label and fallback", () => {
		const result = transformCompose(
			"services:\n  web:\n    image: nginx\n  worker:\n    image: busybox\n",
			{
				appId: "app-1",
				folder: "demo-12345678",
				appRoot: "/etc/nitrobase/apps/demo-12345678",
				network: "nitrobase-network",
				proxiedServices: ["web"],
				instanceId: "inst-1",
				resources: { web: { memoryMb: 256, cpus: 0.5 } },
				fallbackResources: { memoryMb: 128 },
			},
		);
		const services = result.compose.services as Record<
			string,
			Record<string, unknown>
		>;
		expect(effectiveLimits(services.web)).toEqual({ memoryMb: 256, cpus: 0.5 });
		expect(effectiveLimits(services.worker)).toEqual({
			memoryMb: 128,
			cpus: null,
		});
		expect(
			(services.web.labels as Record<string, string>)["nitrobase.instance"],
		).toBe("inst-1");
	});

	it("strips user-provided nitrobase.* labels (ownership cannot be spoofed)", () => {
		const result = transformCompose(
			"services:\n  web:\n    image: nginx\n    labels:\n      nitrobase.instance: someone-else\n",
			{
				appId: "app-1",
				folder: "demo-12345678",
				appRoot: "/etc/nitrobase/apps/demo-12345678",
				network: "nitrobase-network",
				proxiedServices: [],
			},
		);
		const labels = (
			result.compose.services as Record<string, Record<string, unknown>>
		).web.labels as Record<string, string>;
		expect(labels["nitrobase.instance"]).toBeUndefined();
	});
});
