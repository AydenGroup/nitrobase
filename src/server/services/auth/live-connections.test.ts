import { afterEach, describe, expect, it, vi } from "vitest";
import {
	configureAccessRevalidation,
	configureRevalidation,
	endMemberConnections,
	endSessionConnections,
	endUserConnections,
	registerConnection,
	resetLiveConnections,
	revalidateNow,
	SessionEndedError,
	sessionBoundSignal,
	sessionEndedPayload,
} from "./live-connections";

afterEach(() => resetLiveConnections());

const conn = (sessionId: string, userId = "u1") => {
	const close = vi.fn();
	return { sessionId, userId, close };
};

describe("live connections", () => {
	it("revoking a session closes only its connections", () => {
		const a = conn("s1");
		const b = conn("s2");
		registerConnection(a);
		registerConnection(b);
		expect(endSessionConnections("s1")).toBe(1);
		expect(a.close).toHaveBeenCalledWith(expect.any(SessionEndedError));
		expect(b.close).not.toHaveBeenCalled();
		// Closed connections are forgotten.
		expect(endSessionConnections("s1")).toBe(0);
	});

	it("sign out everywhere else keeps the current session", () => {
		const current = conn("keep");
		const other = conn("other");
		const someoneElse = conn("x", "u2");
		for (const item of [current, other, someoneElse]) registerConnection(item);
		expect(endUserConnections("u1", { exceptSessionId: "keep" })).toBe(1);
		expect(other.close).toHaveBeenCalled();
		expect(current.close).not.toHaveBeenCalled();
		expect(someoneElse.close).not.toHaveBeenCalled();
	});

	it("an unregistered connection is not closed", () => {
		const a = conn("s1");
		const unregister = registerConnection(a);
		unregister();
		expect(endSessionConnections("s1")).toBe(0);
		expect(a.close).not.toHaveBeenCalled();
	});

	it("re-validation closes expired, revoked and unknown sessions", async () => {
		const valid = conn("ok");
		const expired = conn("exp");
		const missing = conn("gone");
		for (const item of [valid, expired, missing]) registerConnection(item);
		const validator = vi.fn(
			async () =>
				new Map<string, "expired" | "revoked" | "invalid" | null>([
					["ok", null],
					["exp", "expired"],
				]),
		);
		configureRevalidation(validator, 60_000);
		expect(await revalidateNow()).toBe(2);
		expect(valid.close).not.toHaveBeenCalled();
		expect(expired.close.mock.calls[0][0].reason).toBe("expired");
		expect(missing.close.mock.calls[0][0].reason).toBe("invalid");
		expect(validator).toHaveBeenCalledWith(
			expect.arrayContaining([{ sessionId: "ok", userId: "u1" }]),
		);
	});

	it("a failing validator keeps connections open", async () => {
		const a = conn("s1");
		registerConnection(a);
		configureRevalidation(async () => {
			throw new Error("db down");
		}, 60_000);
		expect(await revalidateNow()).toBe(0);
		expect(a.close).not.toHaveBeenCalled();
	});

	it("runs re-validation on the interval", async () => {
		vi.useFakeTimers();
		try {
			const a = conn("s1");
			registerConnection(a);
			configureRevalidation(
				async () => new Map([["s1", "revoked" as const]]),
				1000,
			);
			await vi.advanceTimersByTimeAsync(1000);
			expect(a.close).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("sessionBoundSignal", () => {
	it("aborts with a SessionEndedError when the session is revoked", () => {
		const parent = new AbortController();
		const { signal } = sessionBoundSignal(
			{ sessionId: "s1", userId: "u1" },
			parent.signal,
		);
		expect(signal.aborted).toBe(false);
		endSessionConnections("s1");
		expect(signal.aborted).toBe(true);
		expect(sessionEndedPayload(signal)?.message).toMatch(
			/session ended: revoked/,
		);
	});

	it("follows the parent signal and unregisters", () => {
		const parent = new AbortController();
		const { signal } = sessionBoundSignal(
			{ sessionId: "s1", userId: "u1" },
			parent.signal,
		);
		parent.abort();
		expect(signal.aborted).toBe(true);
		expect(sessionEndedPayload(signal)).toBeNull();
		expect(endSessionConnections("s1")).toBe(0);
	});

	it("release stops tracking", () => {
		const { signal, release } = sessionBoundSignal({
			sessionId: "s1",
			userId: "u1",
		});
		release();
		endSessionConnections("s1");
		expect(signal.aborted).toBe(false);
	});

	it("closes a member's connections in a team when access changes", () => {
		const access = (teamId: string, permission: string) => ({
			teamId,
			permission,
		});
		const terminal = {
			...conn("s1"),
			access: access("t1", "server.terminal"),
		};
		const logs = { ...conn("s1"), access: access("t1", "app.view") };
		const otherTeam = {
			...conn("s1"),
			access: access("t2", "server.terminal"),
		};
		const otherMember = {
			...conn("s9", "u2"),
			access: access("t1", "server.terminal"),
		};
		for (const item of [terminal, logs, otherTeam, otherMember]) {
			registerConnection(item);
		}
		// Demoted: the terminal goes, the log stream (still allowed) stays.
		expect(
			endMemberConnections(
				"t1",
				"u1",
				(permission) => permission === "app.view",
			),
		).toBe(1);
		expect(terminal.close).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "forbidden" }),
		);
		expect(logs.close).not.toHaveBeenCalled();
		// Removed from the team: everything of that team goes.
		expect(endMemberConnections("t1", "u1")).toBe(1);
		expect(logs.close).toHaveBeenCalled();
		expect(otherTeam.close).not.toHaveBeenCalled();
		expect(otherMember.close).not.toHaveBeenCalled();
	});

	it("the periodic re-check closes connections whose access is gone", async () => {
		const kept = {
			...conn("s1"),
			access: { teamId: "t1", permission: "app.view" },
		};
		const lost = {
			...conn("s2", "u2"),
			access: { teamId: "t1", permission: "app.terminal" },
		};
		registerConnection(kept);
		registerConnection(lost);
		configureRevalidation(
			async (entries) =>
				new Map(entries.map((entry) => [entry.sessionId, null])),
			60_000,
		);
		configureAccessRevalidation(
			async (entries) =>
				new Set(
					entries
						.filter((entry) => entry.userId === "u2")
						.map(
							(entry) => `${entry.userId}|${entry.teamId}|${entry.permission}`,
						),
				),
		);
		expect(await revalidateNow()).toBe(1);
		expect(lost.close).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "forbidden" }),
		);
		expect(kept.close).not.toHaveBeenCalled();
	});
});
