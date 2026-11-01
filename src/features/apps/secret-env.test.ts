import { describe, expect, it } from "vitest";
import { secretEnvKeys } from "./secret-env";

const NAME = "(PASS|SECRET|TOKEN|PRIVATE|_KEY$|^KEY$|ENC_KEY|CRYPTO)";
const VALUE = "^[a-z][a-z0-9+.-]*://[^\\s/:@]*:[^\\s/@]+@";

const keys = (values: Record<string, string>, templateSecrets: string[] = []) =>
	secretEnvKeys({
		values,
		templateSecrets,
		namePattern: NAME,
		valuePattern: VALUE,
	});

describe("secretEnvKeys", () => {
	it("keeps the template secrets and the names that look like secrets", () => {
		expect(
			keys({ ADMIN_PASSWORD: "x", API_TOKEN: "y", SITE_URL: "z" }, [
				"ONLY_TPL",
			]),
		).toEqual(new Set(["ONLY_TPL", "ADMIN_PASSWORD", "API_TOKEN"]));
	});

	it("treats a URL that carries a password as a secret, whatever the name", () => {
		const found = keys({
			DB_URL: "postgres://app:s3cret@db:5432/app",
			CACHE: "redis://:pw@cache:6379/0",
			REMOTE: "https://user:tok@example.com/path",
			AMQP: "AMQP://guest:guest@mq",
		});
		expect([...found].sort()).toEqual(["AMQP", "CACHE", "DB_URL", "REMOTE"]);
	});

	it("leaves ordinary values alone", () => {
		expect(
			keys({
				SITE_URL: "https://example.com:8080/path",
				HOST_PORT: "http://localhost:3000",
				QUEUE_URL: "amqp://guest@mq",
				GIT: "git@github.com:org/repo.git",
				TEXT: "see https://a.b/c, user:pw@x",
				EMPTY: "",
			}),
		).toEqual(new Set());
	});

	it("does not look past the first line break", () => {
		expect(keys({ NOTE: "line one\npostgres://a:b@c" })).toEqual(new Set());
	});
});
