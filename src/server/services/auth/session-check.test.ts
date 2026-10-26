import { describe, expect, it } from "vitest";
import { checkSession, isNewDevice } from "./session-check";

const now = new Date("2026-10-05T12:00:00Z");
const row = {
	userId: "u1",
	expiresAt: new Date("2026-10-06T00:00:00Z"),
	lastSeenAt: new Date("2026-10-05T11:58:00Z"),
	revokedAt: null as Date | null,
};
const minute = 60_000;

describe("checkSession", () => {
	it("accepts a live session and throttles lastSeen writes", () => {
		expect(checkSession(row, "u1", now, 5 * minute)).toEqual({
			valid: true,
			touch: false,
		});
		expect(checkSession(row, "u1", now, minute)).toEqual({
			valid: true,
			touch: true,
		});
	});

	it("rejects revoked, expired, missing and foreign sessions", () => {
		expect(checkSession({ ...row, revokedAt: now }, "u1", now, minute)).toEqual(
			{ valid: false, reason: "revoked" },
		);
		expect(checkSession({ ...row, expiresAt: now }, "u1", now, minute)).toEqual(
			{ valid: false, reason: "expired" },
		);
		expect(checkSession(null, "u1", now, minute)).toEqual({
			valid: false,
			reason: "missing",
		});
		expect(checkSession(row, "u2", now, minute)).toEqual({
			valid: false,
			reason: "user",
		});
		expect(checkSession(row, undefined, now, minute)).toEqual({
			valid: false,
			reason: "user",
		});
	});
});

describe("isNewDevice", () => {
	const seen = [{ ip: "1.1.1.1", userAgent: "Firefox" }];
	it("is new when the IP or the browser was never seen; first login is not", () => {
		expect(isNewDevice([], { ip: "9.9.9.9", userAgent: "X" })).toBe(false);
		expect(isNewDevice(seen, { ip: "1.1.1.1", userAgent: "Firefox" })).toBe(
			false,
		);
		expect(isNewDevice(seen, { ip: "2.2.2.2", userAgent: "Firefox" })).toBe(
			true,
		);
		expect(isNewDevice(seen, { ip: "1.1.1.1", userAgent: "Chrome" })).toBe(
			true,
		);
	});
});
