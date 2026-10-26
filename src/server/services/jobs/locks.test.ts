import { describe, expect, it } from "vitest";
import {
	appLockKey,
	isAppBusy,
	isServerJobBlocked,
	isServerMutationBlocked,
	type LockJob,
} from "./locks";

const state = (locks: string[], jobs: LockJob[]) => ({
	serverLocks: new Set(locks),
	jobs,
});
const task = (appId: string): LockJob => ({
	serverId: "s1",
	appId,
	appScoped: true,
});

describe("job locks", () => {
	it("tasks are blocked by their app, the server's app-less jobs and mutations", () => {
		expect(isAppBusy(state([], []), "s1", "a")).toBe(false);
		expect(isAppBusy(state([appLockKey("a")], [task("a")]), "s1", "a")).toBe(
			true,
		);
		// A deploy of another app holds the server: tasks of "a" still run.
		expect(
			isAppBusy(
				state(["s1"], [{ serverId: "s1", appId: "b", appScoped: false }]),
				"s1",
				"a",
			),
		).toBe(false);
		// A deploy of the same app, a bootstrap, a withServerLock mutation.
		expect(
			isAppBusy(
				state(["s1"], [{ serverId: "s1", appId: "a", appScoped: false }]),
				"s1",
				"a",
			),
		).toBe(true);
		expect(
			isAppBusy(
				state(["s1"], [{ serverId: "s1", appId: null, appScoped: false }]),
				"s1",
				"a",
			),
		).toBe(true);
		expect(isAppBusy(state(["s1"], []), "s1", "a")).toBe(true);
	});

	it("server jobs wait for task runs they would collide with", () => {
		const running = state([appLockKey("a")], [task("a")]);
		// Deploy/backup of another app: not blocked by a's task.
		expect(isServerJobBlocked(running, { serverId: "s1", appId: "b" })).toBe(
			false,
		);
		// Deploy of the same app, bootstrap/orphan wipe (no app): blocked.
		expect(isServerJobBlocked(running, { serverId: "s1", appId: "a" })).toBe(
			true,
		);
		expect(isServerJobBlocked(running, { serverId: "s1" })).toBe(true);
		// Another server is unaffected; a move locking s1 too is blocked.
		expect(isServerJobBlocked(running, { serverId: "s2" })).toBe(false);
		expect(
			isServerJobBlocked(state(["s1"], []), {
				serverId: "s2",
				alsoLock: ["s1"],
			}),
		).toBe(true);
	});

	it("server-level withServerLock mutations wait for any app job on the server", () => {
		expect(
			isServerMutationBlocked(state([appLockKey("a")], [task("a")]), "s1"),
		).toBe(true);
		expect(isServerMutationBlocked(state([], []), "s1")).toBe(false);
		expect(isServerMutationBlocked(state(["s1"], []), "s1")).toBe(true);
	});

	it("app-scoped mutations only wait for their own app's job", () => {
		const building = state([appLockKey("a")], [task("a")]);
		// App "b" stays editable while "a" builds or runs a task.
		expect(isServerMutationBlocked(building, "s1", "b")).toBe(false);
		// App "a" itself is busy.
		expect(isServerMutationBlocked(building, "s1", "a")).toBe(true);
		// A server-level job (deploy, bootstrap) or mutation blocks every app.
		expect(isServerMutationBlocked(state(["s1"], []), "s1", "b")).toBe(true);
		expect(
			isServerMutationBlocked(
				state(["s1"], [{ serverId: "s1", appId: "a", appScoped: false }]),
				"s1",
				"b",
			),
		).toBe(true);
		// Other servers are unaffected.
		expect(isServerMutationBlocked(building, "s2", "c")).toBe(false);
		expect(isServerMutationBlocked(building, "s2")).toBe(false);
	});
});
