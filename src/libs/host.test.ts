import { describe, expect, it } from "vitest";
import { isServerHost } from "./host";

describe("isServerHost", () => {
	it("accepts IPs and hostnames", () => {
		for (const host of [
			"192.168.1.10",
			"::1",
			"2001:db8::5",
			"vps1",
			"my-box.example.com",
			" Host.IO ",
		]) {
			expect(isServerHost(host), host).toBe(true);
		}
	});
	it("rejects junk", () => {
		for (const host of [
			"bad host!!",
			"",
			"a..b",
			"-x.com",
			"x_y.com",
			"http://x.com",
			"root@x.com",
			"x.com:22",
		]) {
			expect(isServerHost(host), host).toBe(false);
		}
	});
});
