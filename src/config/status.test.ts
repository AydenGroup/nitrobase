import { describe, expect, it } from "vitest";
import { serviceRunState } from "#/server/services/apps/readiness.ts";
import { appDisplayStatus, appStatuses, degradedAppStatus } from "./status";

describe("app display status (BUG-015)", () => {
	const services = [
		"appwrite",
		"postgresql",
		"redis",
		"appwrite-browser",
		"migrate",
	];
	const sample = (service: string, state: string) => ({ service, state });
	// After a reboot of the host: what upstream left without a restart policy.
	const afterReboot = [
		sample("appwrite", "exited"),
		sample("postgresql", "exited"),
		sample("redis", "running"),
		sample("appwrite-browser", "restarting"),
		sample("migrate", "exited"),
	];

	it("lists long-running services without a running container", () => {
		expect(
			serviceRunState(services, afterReboot, {
				oneShot: new Set(["migrate"]),
			}),
		).toEqual({
			notRunning: ["appwrite", "postgresql", "appwrite-browser"],
			missing: [],
		});
		expect(
			serviceRunState(
				["web"],
				[sample("web", "exited"), sample("web", "running")],
			).notRunning,
		).toEqual([]);
	});

	it("tells missing containers apart, minus optional ones", () => {
		// No container at all: Start cannot help, a redeploy creates it.
		expect(
			serviceRunState(["web", "db", "debug"], [sample("web", "running")], {
				optional: new Set(["debug"]),
			}),
		).toEqual({ notRunning: [], missing: ["db"] });
		// A profile-gated service that was started counts again.
		expect(
			serviceRunState(["debug"], [sample("debug", "exited")], {
				optional: new Set(["debug"]),
			}).notRunning,
		).toEqual(["debug"]);
	});

	it("leaves out services the owner stopped", () => {
		expect(
			serviceRunState(services, afterReboot, {
				oneShot: new Set(["migrate"]),
				stopped: new Set(["postgresql", "appwrite-browser"]),
			}).notRunning,
		).toEqual(["appwrite"]);
	});

	it("shows a running app with stopped services as partially running", () => {
		expect(appDisplayStatus("running", ["postgresql"])).toBe(degradedAppStatus);
		expect(appDisplayStatus("running", [])).toBe(appStatuses.running);
		expect(appDisplayStatus("running")).toBe(appStatuses.running);
	});

	it("keeps statuses where services are not expected to run", () => {
		for (const status of [
			"stopped",
			"deploying",
			"error",
			"pending",
		] as const) {
			expect(appDisplayStatus(status, ["postgresql"])).toBe(
				appStatuses[status],
			);
		}
	});
});
