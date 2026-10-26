import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "#/db/errors.ts";
import { evaluateCertificate, evaluateDns } from "./checkers";
import { getFreeDomainProvider } from "./free-domains";

const sslip = getFreeDomainProvider("sslip.io");
const nipIo = getFreeDomainProvider("nip.io");

import { normalizeDomainInput } from "./normalize";

describe("free domain providers", () => {
	it("builds sslip.io / nip.io hosts", () => {
		expect(sslip.hostFor("pocketbase-1a2b3c4d", "203.0.113.7")).toBe(
			"pocketbase-1a2b3c4d.203-0-113-7.sslip.io",
		);
		expect(sslip.hostFor("app", "2001:db8::1")).toBe(
			"app.2001-db8--1.sslip.io",
		);
		expect(nipIo.hostFor("app", "10.0.0.2")).toBe("app.10-0-0-2.nip.io");
		expect(() => nipIo.hostFor("app", "2001:db8::1")).toThrow();
		expect(sslip.owns("a.1-2-3-4.sslip.io")).toBe(true);
		expect(getFreeDomainProvider("sslip.io")).toBe(sslip);
		expect(() => getFreeDomainProvider("nope")).toThrow();
	});
});

describe("domain input and uniqueness", () => {
	it("normalizes pasted URLs and rejects garbage", () => {
		expect(normalizeDomainInput(" https://App.Example.org/path?x ")).toBe(
			"app.example.org",
		);
		expect(normalizeDomainInput("app.example.org:8443")).toBe(
			"app.example.org",
		);
		expect(normalizeDomainInput("app.example.org.")).toBe("app.example.org");
		expect(() => normalizeDomainInput("localhost")).toThrow();
		expect(() => normalizeDomainInput("*.example.org")).toThrow();
		expect(() => normalizeDomainInput("a`b.org")).toThrow();
	});

	it("recognizes unique violations from pg and drizzle-wrapped errors", () => {
		expect(isUniqueViolation({ code: "23505" })).toBe(true);
		expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
		expect(isUniqueViolation({ code: "23503" })).toBe(false);
		expect(isUniqueViolation(new Error("x"))).toBe(false);
	});
});

describe("checkers", () => {
	it("evaluates DNS against server IPs", () => {
		expect(evaluateDns([], ["1.2.3.4"]).status).toBe("error");
		expect(evaluateDns(["1.2.3.4"], ["1.2.3.4"]).status).toBe("ok");
		expect(evaluateDns(["1.2.3.4", "5.6.7.8"], ["1.2.3.4"]).status).toBe(
			"warning",
		);
		expect(evaluateDns(["9.9.9.9"], ["1.2.3.4"]).status).toBe("error");
		expect(evaluateDns(["9.9.9.9"], []).status).toBe("warning");
	});

	it("evaluates certificates", () => {
		const now = new Date("2026-01-01T00:00:00Z");
		const cert = (patch: Partial<Parameters<typeof evaluateCertificate>[0]>) =>
			evaluateCertificate(
				{
					issuer: "Let's Encrypt R11",
					validTo: new Date("2026-03-01"),
					authorized: true,
					...patch,
				},
				now,
				14,
			);
		expect(cert({}).status).toBe("ok");
		expect(cert({ validTo: new Date("2026-01-05") }).status).toBe("warning");
		expect(cert({ validTo: new Date("2025-12-01") }).status).toBe("error");
		expect(
			cert({ authorized: false, issuer: "TRAEFIK DEFAULT CERT" }).message,
		).toEqual({ code: "cert_default" });
		expect(evaluateDns(["9.9.9.9"], ["1.2.3.4"]).message).toEqual({
			code: "dns_mismatch",
			params: { resolved: "9.9.9.9", expected: "1.2.3.4" },
		});
		expect(cert({ validTo: new Date("2026-01-05") }).message).toEqual({
			code: "cert_expiring",
			params: {
				issuer: "Let's Encrypt R11",
				expiresAt: "2026-01-05T00:00:00.000Z",
				days: 4,
			},
		});
		expect(cert({ issuer: "(STAGING) Let's Encrypt" }).status).toBe("warning");
	});
});
