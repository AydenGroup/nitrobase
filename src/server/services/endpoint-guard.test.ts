import { describe, expect, it } from "vitest";
import { checkEndpointHost, endpointHostOf } from "./endpoint-guard";

const fakeDns = (table: Record<string, string[]>) => async (host: string) => {
	const addresses = table[host];
	if (!addresses) throw new Error("ENOTFOUND");
	return addresses.map((address) => ({ address }));
};

describe("save-time endpoint check", () => {
	const resolve = fakeDns({
		"s3.example.com": ["93.184.216.34"],
		"internal.example.com": ["10.0.0.5"],
		"mixed.example.com": ["93.184.216.34", "127.0.0.1"],
		"rebind.example.com": ["::ffff:192.168.1.1"],
	});

	it("rejects names that resolve to private or loopback addresses", async () => {
		expect(
			await checkEndpointHost("s3.example.com", {
				allowPrivate: false,
				resolve,
			}),
		).toBe("ok");
		expect(
			await checkEndpointHost("internal.example.com", {
				allowPrivate: false,
				resolve,
			}),
		).toBe("private");
		expect(
			await checkEndpointHost("mixed.example.com", {
				allowPrivate: false,
				resolve,
			}),
		).toBe("private");
		expect(
			await checkEndpointHost("rebind.example.com", {
				allowPrivate: false,
				resolve,
			}),
		).toBe("private");
		expect(
			await checkEndpointHost("missing.example.com", {
				allowPrivate: false,
				resolve,
			}),
		).toBe("unresolved");
	});

	it("checks literal addresses without DNS and honours the private option", async () => {
		expect(
			await checkEndpointHost("127.0.0.1", { allowPrivate: false, resolve }),
		).toBe("private");
		expect(
			await checkEndpointHost("[::1]", { allowPrivate: false, resolve }),
		).toBe("private");
		expect(
			await checkEndpointHost("1.1.1.1", { allowPrivate: false, resolve }),
		).toBe("ok");
		expect(
			await checkEndpointHost("internal.example.com", {
				allowPrivate: true,
				resolve,
			}),
		).toBe("ok");
	});

	it("extracts the host of URLs and bare host fields", () => {
		expect(endpointHostOf("https://s3.example.com:9000/bucket")).toBe(
			"s3.example.com",
		);
		expect(endpointHostOf("smtp.example.com")).toBe("smtp.example.com");
		expect(endpointHostOf("")).toBeNull();
		expect(endpointHostOf(42)).toBeNull();
	});
});
