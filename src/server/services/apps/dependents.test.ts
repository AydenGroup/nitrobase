import { describe, expect, it } from "vitest";
import {
	composeDependsOn,
	dependentsToRestart,
	parseContainerIdentities,
} from "./dependents";

/**
 * Which running dependents a deploy restarts after `up` recreated a
 * service (OneDev #20, BUG-023: a resource change recreated only
 * `postgresql`; `appwrite` kept its dead connections and answered 500).
 */

type Row = [service: string, id: string, startedAt: string, state?: string];
const identities = (rows: Row[]) =>
	parseContainerIdentities(
		rows
			.map(([service, id, startedAt, state = "running"]) =>
				[service, id, startedAt, state].join("\t"),
			)
			.join("\n"),
	);

/** Appwrite-like: the API and a worker need MongoDB and PostgreSQL. */
const dependsOn = {
	appwrite: ["mongodb", "postgresql"],
	"appwrite-worker": ["appwrite", "postgresql"],
	realtime: ["appwrite"],
};
const before = identities([
	["mongodb", "m1", "t0"],
	["postgresql", "p1", "t0"],
	["appwrite", "a1", "t0"],
	["appwrite-worker", "w1", "t0"],
	["realtime", "r1", "t0"],
]);

describe("dependentsToRestart", () => {
	it("restarts every running dependent of a recreated service, transitively", () => {
		const after = identities([
			["mongodb", "m1", "t0"],
			["postgresql", "p2", "t1"],
			["appwrite", "a1", "t0"],
			["appwrite-worker", "w1", "t0"],
			["realtime", "r1", "t0"],
		]);
		expect(dependentsToRestart({ before, after, dependsOn })).toEqual({
			restart: ["appwrite", "appwrite-worker", "realtime"],
			changed: ["postgresql"],
		});
	});

	it("restarts nothing when up changed nothing", () => {
		expect(dependentsToRestart({ before, after: before, dependsOn })).toEqual({
			restart: [],
			changed: [],
		});
	});

	it("restarts only what depends on the changed service", () => {
		// realtime only depends on appwrite, which was recreated itself.
		const after = identities([
			["mongodb", "m1", "t0"],
			["postgresql", "p1", "t0"],
			["appwrite", "a2", "t1"],
			["appwrite-worker", "w1", "t0"],
			["realtime", "r1", "t0"],
		]);
		expect(dependentsToRestart({ before, after, dependsOn })).toEqual({
			restart: ["appwrite-worker", "realtime"],
			changed: ["appwrite"],
		});
	});

	it("counts a container that up restarted (same id, new start) as changed", () => {
		const after = identities([
			["mongodb", "m1", "t2"],
			["postgresql", "p1", "t0"],
			["appwrite", "a1", "t0"],
			["appwrite-worker", "w1", "t0"],
			["realtime", "r1", "t0"],
		]);
		expect(dependentsToRestart({ before, after, dependsOn }).restart).toEqual([
			"appwrite",
			"appwrite-worker",
			"realtime",
		]);
	});

	it("leaves services up recreated too (they connected to the new one)", () => {
		const after = identities([
			["mongodb", "m1", "t0"],
			["postgresql", "p2", "t1"],
			["appwrite", "a2", "t1"],
			["appwrite-worker", "w2", "t1"],
			["realtime", "r1", "t0"],
		]);
		expect(dependentsToRestart({ before, after, dependsOn })).toEqual({
			restart: ["realtime"],
			changed: ["appwrite"],
		});
	});

	it("restarts nothing on a first deploy", () => {
		const after = identities([
			["postgresql", "p1", "t0"],
			["appwrite", "a1", "t0"],
		]);
		expect(
			dependentsToRestart({ before: new Map(), after, dependsOn }).restart,
		).toEqual([]);
	});

	it("leaves a dependent stopped by its owner stopped", () => {
		const stoppedBefore = identities([
			["postgresql", "p1", "t0"],
			["appwrite", "a1", "t0", "exited"],
		]);
		const after = identities([
			["postgresql", "p2", "t1"],
			["appwrite", "a1", "t0", "exited"],
		]);
		expect(
			dependentsToRestart({ before: stoppedBefore, after, dependsOn }).restart,
		).toEqual([]);
	});

	it("ignores a declared one-shot even while it still runs", () => {
		// `setup` has no restart policy: up re-ran it, it is still running.
		const deps = { app: ["setup", "db"] };
		const start = identities([
			["setup", "s1", "t0", "exited"],
			["db", "d1", "t0"],
			["app", "a1", "t0"],
		]);
		const after = identities([
			["setup", "s1", "t1"],
			["db", "d1", "t0"],
			["app", "a1", "t0"],
		]);
		expect(
			dependentsToRestart({
				before: start,
				after,
				dependsOn: deps,
				oneShot: new Set(["setup"]),
			}),
		).toEqual({ restart: [], changed: [] });
		// Without the one-shot set it would have counted.
		expect(
			dependentsToRestart({ before: start, after, dependsOn: deps }).restart,
		).toEqual(["app"]);
	});

	it("ignores a one-shot up ran again that has exited", () => {
		const oneShot = { appwrite: ["migrate"] };
		const withJob = identities([
			["migrate", "j1", "t0", "exited"],
			["appwrite", "a1", "t0"],
		]);
		const after = identities([
			["migrate", "j1", "t1", "exited"],
			["appwrite", "a1", "t0"],
		]);
		expect(
			dependentsToRestart({ before: withJob, after, dependsOn: oneShot }),
		).toEqual({ restart: [], changed: [] });
	});

	it("follows depends_on through a service up did not touch", () => {
		// db changed; cache (untouched, but not running) sits in between.
		const chain = { app: ["cache"], cache: ["db"] };
		const start = identities([
			["db", "d1", "t0"],
			["cache", "c1", "t0", "exited"],
			["app", "a1", "t0"],
		]);
		const after = identities([
			["db", "d2", "t1"],
			["cache", "c1", "t0", "exited"],
			["app", "a1", "t0"],
		]);
		expect(
			dependentsToRestart({ before: start, after, dependsOn: chain }),
		).toEqual({ restart: ["app"], changed: ["db"] });
	});

	it("survives a depends_on cycle", () => {
		const cycle = { a: ["b"], b: ["a", "db"] };
		const start = identities([
			["db", "d1", "t0"],
			["a", "a1", "t0"],
			["b", "b1", "t0"],
		]);
		const after = identities([
			["db", "d2", "t1"],
			["a", "a1", "t0"],
			["b", "b1", "t0"],
		]);
		expect(
			dependentsToRestart({ before: start, after, dependsOn: cycle }).restart,
		).toEqual(["b", "a"]);
	});
});

describe("composeDependsOn", () => {
	const model = {
		services: {
			app: {
				depends_on: {
					db: { condition: "service_healthy" },
					migrate: { condition: "service_completed_successfully" },
				},
			},
			worker: { depends_on: ["db"] },
			db: {},
		},
	};

	it("reads the list and map forms", () => {
		expect(composeDependsOn(model)).toEqual({
			app: ["db", "migrate"],
			worker: ["db"],
			db: [],
		});
	});

	it("runtimeOnly leaves out jobs waited on to finish", () => {
		expect(composeDependsOn(model, { runtimeOnly: true }).app).toEqual(["db"]);
	});
});

describe("parseContainerIdentities", () => {
	it("groups replicas per service and skips unlabelled containers", () => {
		const parsed = parseContainerIdentities(
			[
				"web\tb\tt1\trunning",
				"web\ta\tt0\trunning",
				"<no value>\tx\tt0\trunning",
				"",
			].join("\n"),
		);
		expect([...parsed.keys()]).toEqual(["web"]);
		expect(parsed.get("web")?.map((item) => item.id)).toEqual(["a", "b"]);
	});
});
