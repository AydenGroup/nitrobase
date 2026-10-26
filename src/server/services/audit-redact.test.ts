import { describe, expect, it } from "vitest";
import { REDACTED, redactAuditMeta } from "./audit-redact";

describe("redactAuditMeta", () => {
	it("replaces values under sensitive keys, at any depth", () => {
		expect(
			redactAuditMeta({
				keys: ["DB_PASSWORD", "API_URL"],
				password: "hunter2",
				nested: { secretAccessKey: "x", apiKey: "y", token: "z", name: "ok" },
				webhookUrl: "https://hooks.example.com/abc",
				values: { DB_PASSWORD: "p" },
				destinationId: "d1",
				count: 3,
			}),
		).toEqual({
			keys: ["DB_PASSWORD", "API_URL"],
			password: REDACTED,
			nested: {
				secretAccessKey: REDACTED,
				apiKey: REDACTED,
				token: REDACTED,
				name: "ok",
			},
			webhookUrl: REDACTED,
			values: REDACTED,
			destinationId: "d1",
			count: 3,
		});
	});

	it("cuts long strings, big arrays and deep objects", () => {
		const meta = redactAuditMeta({
			long: "x".repeat(1000),
			list: Array.from({ length: 100 }, (_, i) => i),
			a: { b: { c: { d: { e: 1 } } } },
		}) as Record<string, unknown>;
		expect((meta.long as string).length).toBe(301);
		expect((meta.list as number[]).length).toBe(50);
		expect(meta.a).toEqual({ b: { c: { d: "[…]" } } });
		expect(redactAuditMeta(undefined)).toBeNull();
	});

	it("keeps a setting's name visible (settings.update)", () => {
		expect(
			redactAuditMeta({ setting: "github.token", cleared: false }),
		).toEqual({ setting: "github.token", cleared: false });
	});
});
