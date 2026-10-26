import { describe, expect, it, vi } from "vitest";
import type { JobLogger } from "#/features/deployments/deployments.server.ts";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { destinationDrivers, driverFields, getDestinationDriver, secretFields } =
	await import("#/config/backup-drivers.ts");
const {
	rcloneCommand,
	rcloneFailure,
	redactor,
	remotePath,
	renderRcloneConfig,
	summarizeRcloneError,
} = await import("./rclone");

const driverOf = (type: string) => {
	const driver = getDestinationDriver(type);
	if (!driver) throw new Error(`no driver ${type}`);
	return driver;
};
const env = { localRoot: "/var/backups/nitrobase" };
const s3 = {
	endpoint: "https://s3.example.com",
	region: "eu-1",
	bucket: "my-bucket",
	prefix: "prod",
	accessKeyId: "AKIAEXAMPLE",
	secretAccessKey: "s3cr3t/with+chars=",
	pathStyle: true,
};

describe("destination drivers", () => {
	it("registers local, s3, r2 and b2 with form fields", () => {
		expect(destinationDrivers.map((driver) => driver.type)).toEqual([
			"local",
			"s3",
			"r2",
			"b2",
		]);
		const fields = driverFields(driverOf("s3"));
		expect(fields.map((field) => field.name)).toEqual([
			"endpoint",
			"region",
			"bucket",
			"prefix",
			"accessKeyId",
			"secretAccessKey",
			"pathStyle",
			"privateEndpoint",
		]);
		expect(fields.find((f) => f.name === "pathStyle")?.kind).toBe("boolean");
		expect(fields.find((f) => f.name === "region")?.required).toBe(false);
		expect(secretFields(driverOf("s3"))).toEqual(["secretAccessKey"]);
		expect(secretFields(driverOf("b2"))).toEqual(["applicationKey"]);
	});

	it("renders rclone sections", () => {
		const driver = driverOf("s3");
		const remote = driver.toRclone(driver.schema.parse(s3), env);
		expect(renderRcloneConfig(remote)).toBe(
			[
				"[dest]",
				"type = s3",
				"provider = Other",
				"env_auth = false",
				"access_key_id = AKIAEXAMPLE",
				"secret_access_key = s3cr3t/with+chars=",
				"endpoint = https://s3.example.com",
				"region = eu-1",
				"force_path_style = true",
				"no_check_bucket = true",
				"",
			].join("\n"),
		);
		expect(remote.base).toBe("my-bucket/prod");

		const r2 = driverOf("r2");
		const r2Remote = r2.toRclone(
			r2.schema.parse({
				...s3,
				accountId: "0123456789abcdef0123456789abcdef",
			}),
			env,
		);
		expect(r2Remote.section.endpoint).toBe(
			"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
		);
		const local = driverOf("local");
		expect(local.toRclone(local.schema.parse({ path: "apps" }), env)).toEqual({
			section: { type: "local" },
			base: "/backups/apps",
			mount: { host: "/var/backups/nitrobase", container: "/backups" },
		});
	});

	it("rejects config values that could inject rclone.conf lines", () => {
		const driver = driverOf("s3");
		expect(
			driver.schema.safeParse({ ...s3, secretAccessKey: "a\n[evil]" }).success,
		).toBe(false);
		expect(
			driver.schema.safeParse({ ...s3, prefix: "../../etc" }).success,
		).toBe(false);
		expect(() =>
			renderRcloneConfig({ section: { type: "s3\nx = y" }, base: "" }),
		).toThrow();
	});
});

describe("rclone command", () => {
	const driver = driverOf("s3");
	const remote = driver.toRclone(driver.schema.parse(s3), env);

	it("keeps credentials out of argv (config file mounted read-only)", () => {
		const command = rcloneCommand({
			image: "rclone/rclone:1.71.1",
			confPath: "/etc/nitrobase/backup-work/backup-abc/rclone.conf",
			remote,
			workDir: "/etc/nitrobase/backup-work/backup-abc",
			workReadOnly: true,
			args: [
				"copyto",
				"/work/archive.tar.zst",
				remotePath(remote, "app/x.tar.zst"),
			],
		});
		expect(command).toBe(
			"docker run --rm -i --init -v '/etc/nitrobase/backup-work/backup-abc/rclone.conf:/config/rclone/rclone.conf:ro' -v '/etc/nitrobase/backup-work/backup-abc:/work:ro' 'rclone/rclone:1.71.1' --config /config/rclone/rclone.conf 'copyto' '/work/archive.tar.zst' 'dest:my-bucket/prod/app/x.tar.zst'",
		);
		expect(command).not.toContain(s3.secretAccessKey);
		expect(command).not.toContain(s3.accessKeyId);
	});

	it("validates arguments and keys", () => {
		expect(() =>
			rcloneCommand({
				image: "r",
				confPath: "/c",
				remote,
				args: ["cat", "dest:x; rm -rf /"],
			}),
		).toThrow();
		for (const key of ["/abs", "../x", "a/../b", "a//b", "a b", ""]) {
			expect(() => remotePath(remote, key)).toThrow();
		}
	});

	it("redacts secrets", () => {
		expect(
			redactor(["s3cr3t/with+chars="])("error s3cr3t/with+chars= bad"),
		).toBe("error [redacted] bad");
	});
});

describe("endpoint validation", () => {
	const s3Driver = () => {
		const driver = getDestinationDriver("s3");
		if (!driver) throw new Error("no s3");
		return driver;
	};
	it.each([
		"http://s3.example.com",
		"https://127.0.0.1:9000",
		"https://169.254.169.254",
		"https://10.0.0.5",
		"https://localhost",
		"https://[::1]:9000",
		"https://192.168.1.10",
	])("refuses %s unless private endpoints are allowed", (endpoint) => {
		const driver = s3Driver();
		expect(driver.schema.safeParse({ ...s3, endpoint }).success).toBe(false);
		expect(
			driver.schema.safeParse({ ...s3, endpoint, privateEndpoint: true })
				.success,
		).toBe(true);
	});
	it("accepts https to a public host", () => {
		expect(s3Driver().schema.safeParse(s3).success).toBe(true);
	});
});

describe("summarizeRcloneError", () => {
	it("collapses retries and classifies a bad secret", () => {
		const stderr = [
			"2026/10/04 18:00:00 ERROR : Attempt 1/3 failed with 1 errors and: SignatureDoesNotMatch: The request signature we calculated does not match",
			"2026/10/04 18:00:01 ERROR : Attempt 2/3 failed with 1 errors and: SignatureDoesNotMatch: The request signature we calculated does not match",
			"2026/10/04 18:00:02 ERROR : Attempt 3/3 failed with 1 errors and: SignatureDoesNotMatch: The request signature we calculated does not match",
			"Failed to copyto: https response error StatusCode: 403",
		].join("\n");
		expect(summarizeRcloneError(stderr)).toEqual({
			kind: "auth",
			detail: [
				"SignatureDoesNotMatch: The request signature we calculated does not match",
				"Failed to copyto: https response error StatusCode: 403",
			].join("\n"),
		});
	});

	it("ignores request ids when collapsing retries", () => {
		const stderr = [
			"ERROR : Attempt 1/3 failed with 1 errors and: AccessDenied: denied, RequestID: 1863A2B, HostID: abc=",
			"ERROR : Attempt 2/3 failed with 1 errors and: AccessDenied: denied, RequestID: 99F00C1, HostID: def=",
		].join("\n");
		expect(summarizeRcloneError(stderr).detail).toBe("AccessDenied: denied,");
	});

	it("classifies missing buckets, network and unknown errors", () => {
		expect(summarizeRcloneError("NoSuchBucket: nope").kind).toBe("not_found");
		expect(
			summarizeRcloneError("dial tcp 10.0.0.1:9000: connection refused").kind,
		).toBe("network");
		expect(summarizeRcloneError("something odd").kind).toBe("unknown");
	});
});

describe("rcloneFailure", () => {
	it("keeps the job error short and the raw lines in the log", () => {
		const lines: string[] = [];
		const events: string[] = [];
		const error = rcloneFailure(
			"upload",
			[
				"2026/10/05 01:24:36 ERROR : archive.tar.zst: Failed to copy: operation error S3: PutObject, https response error StatusCode: 404, RequestID: 1, api error NoSuchBucket: The specified bucket does not exist",
				"2026/10/05 01:24:36 ERROR : archive.tar.zst: Failed to copy: operation error S3: PutObject, https response error StatusCode: 404, RequestID: 2, api error NoSuchBucket: The specified bucket does not exist",
			].join("\n"),
			{
				log: (line) => {
					lines.push(line);
				},
				event: ((code: string) => {
					events.push(code);
				}) as JobLogger["event"],
			},
		);
		expect(error.code).toBe("RCLONE_UPLOAD_FAILED");
		expect(error.params).toEqual({
			reason: {
				$error: { code: "RCLONE_NOT_FOUND", params: {}, text: null },
			},
		});
		expect(events).toEqual(["backup.rclone_details"]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/NoSuchBucket/);
	});
});
