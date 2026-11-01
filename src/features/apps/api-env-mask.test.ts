import { describe, expect, it, vi } from "vitest";

/**
 * The env API clients get (`getAppEnvForApi`) masks more than the UI's
 * view: copies of secret values and URLs with credentials.
 */

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));
vi.mock("#/db/index.ts", () => ({ db: {} }));

const { apiMaskedEnvNames } = await import("./apps.server");
const { maskedEnvText } = await import("#/server/services/apps/env-state.ts");
const { SECRET_MASK } = await import("#/libs/env-file.ts");

const quoted = (value: string) => `'${value}'`;

const values = {
	DB_PASSWORD: "hunter2-password",
	// A copy of the secret under a name nothing marks secret.
	WORDPRESS_DB_PASS_COPY: "hunter2-password",
	DSN: "host=db password=hunter2-password",
	DATABASE_URL: "postgres://blog:pa55word@db:5432/blog",
	REDIS_URL: "redis://:onlypass@cache:6379",
	SITE_URL: "https://blog.example.com/path",
	PLAIN: "hello",
};

function masked() {
	return maskedEnvText(
		values,
		apiMaskedEnvNames(values, new Set(["DB_PASSWORD"]), ["hunter2-password"]),
	);
}

describe("apiMaskedEnvNames", () => {
	it("masks secrets, their copies and URL credentials", () => {
		const text = masked();
		expect(text).not.toContain("hunter2-password");
		expect(text).not.toContain("pa55word");
		expect(text).not.toContain("onlypass");
		for (const name of [
			"DB_PASSWORD",
			"WORDPRESS_DB_PASS_COPY",
			"DSN",
			"DATABASE_URL",
			"REDIS_URL",
		]) {
			expect(text).toContain(`${name}=${quoted(SECRET_MASK)}`);
		}
	});

	it("keeps ordinary values readable", () => {
		const text = masked();
		expect(text).toContain("https://blog.example.com/path");
		expect(text).toMatch(/^PLAIN=.?hello.?$/m);
	});
});
