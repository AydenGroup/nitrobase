import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeader: () => undefined,
	getRequestIP: () => undefined,
}));

const { forwardedClientIp } = await import("./request-info");

describe("forwardedClientIp", () => {
	it("takes the entry appended by the trusted proxy, not the client's", () => {
		// Client sent "1.1.1.1" itself; Traefik appended the real 9.9.9.9.
		expect(forwardedClientIp("1.1.1.1, 9.9.9.9", 1)).toBe("9.9.9.9");
		expect(forwardedClientIp("1.1.1.1, 9.9.9.9, 10.0.0.2", 2)).toBe("9.9.9.9");
		expect(forwardedClientIp("9.9.9.9", 2)).toBeNull();
		expect(forwardedClientIp(null, 1)).toBeNull();
	});
});
