import { describe, expect, it } from "vitest";
import { isPrivateHost, parseIPv6 } from "./ip-ranges";

describe("isPrivateHost", () => {
	it.each([
		"127.0.0.1",
		"10.1.2.3",
		"172.20.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"198.18.0.1",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
		"localhost",
		"api.localhost",
		"::1",
		"::",
		"[::1]",
		"fd00::1",
		"fe80::1%eth0",
		"ff02::1",
		// IPv4-mapped / compatible / NAT64 / 6to4, every notation
		"::ffff:127.0.0.1",
		"[::ffff:7f00:1]",
		"::ffff:a9fe:a9fe",
		"0:0:0:0:0:ffff:7f00:0001",
		"::127.0.0.1",
		"::7f00:1",
		"64:ff9b::a9fe:a9fe",
		"64:ff9b::127.0.0.1",
		"2002:7f00:1::",
		"::ffff:0:7f00:1",
		// non-canonical numeric names
		"2130706433",
		"0x7f.0.0.1",
	])("blocks %s", (host) => {
		expect(isPrivateHost(host)).toBe(true);
	});

	it.each([
		"8.8.8.8",
		"1.1.1.1",
		"172.32.0.1",
		"example.com",
		"::ffff:8.8.8.8",
		"2606:4700:4700::1111",
		"64:ff9b::808:808",
	])("allows %s", (host) => {
		expect(isPrivateHost(host)).toBe(false);
	});

	it("parses IPv6 forms", () => {
		expect(parseIPv6("::ffff:127.0.0.1")).toEqual([
			0, 0, 0, 0, 0, 0xffff, 0x7f00, 1,
		]);
		expect(parseIPv6("1::2::3")).toBeNull();
		expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
	});
});
