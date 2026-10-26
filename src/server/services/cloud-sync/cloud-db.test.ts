import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { caBundle, tlsMode } from "./cloud-db";

const CERT = (body: string) =>
	`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;

describe("cloud database TLS", () => {
	it("verifies whenever a CA is present, whatever the opt-ins", () => {
		for (const allowPrivate of [true, false]) {
			for (const allowUnverified of [true, false]) {
				expect(tlsMode("ca", { allowPrivate, allowUnverified })).toBe(
					"verify-full",
				);
			}
		}
	});

	it("refuses to connect without a CA unless unverified TLS is opted in", () => {
		expect(tlsMode(null, { allowPrivate: false, allowUnverified: false })).toBe(
			"missing",
		);
		expect(tlsMode(null, { allowPrivate: false, allowUnverified: true })).toBe(
			"require",
		);
		// Test doubles on private networks only.
		expect(tlsMode(null, { allowPrivate: true, allowUnverified: false })).toBe(
			"disable",
		);
	});

	it("defaults to the CA file shipped with the repository", async () => {
		const { loadConfig } = await import("#/config/server.ts");
		const path = loadConfig(
			{} as NodeJS.ProcessEnv,
		).CLOUD_SYNC_SUPABASE_CA_FILE;
		// Comments only until the owner pastes the certificates; never junk.
		const shipped = readFileSync(path, "utf8");
		const leftover = shipped
			.replace(
				/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
				"",
			)
			.split("\n")
			.filter((line) => line.trim() && !line.startsWith("#"));
		expect(leftover).toEqual([]);
	});

	it("bundles the instance file and the connection's own certificates", () => {
		const dir = mkdtempSync("/tmp/cs-ca-");
		writeFileSync(
			`${dir}/ca.pem`,
			`# comment\n${CERT("AAA")}\n${CERT("BBB")}\n`,
		);
		expect(caBundle(CERT("CCC"), `${dir}/ca.pem`)).toBe(
			`${CERT("AAA")}\n${CERT("BBB")}\n${CERT("CCC")}\n`,
		);
		expect(caBundle("", `${dir}/missing.pem`)).toBeNull();
		expect(caBundle(CERT("CCC"), `${dir}/missing.pem`)).toBe(
			`${CERT("CCC")}\n`,
		);
	});
});
