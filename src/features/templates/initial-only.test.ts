import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { TemplateManifestSchema } from "./schema";

/**
 * `initial_only` variables (OneDev #11, BUG-014): values the app reads on
 * its first start only, e.g. the PocketBase superuser it creates once.
 */
const base = {
	id: "demo",
	name: "Demo",
	source: { repo: "a/b", versions: "tags" },
};

const shipped = (id: string) =>
	TemplateManifestSchema.parse(
		parse(readFileSync(`templates/${id}/template.toml`, "utf8")),
	);

describe("template initial_only flag", () => {
	it("defaults to false and parses when set", () => {
		const manifest = TemplateManifestSchema.parse({
			...base,
			variables: {
				A: { value: "x" },
				B: { value: "${password:20}", editable: true, initial_only: true },
			},
		});
		expect(manifest.variables.A.initial_only).toBe(false);
		expect(manifest.variables.B.initial_only).toBe(true);
	});

	it("cannot be combined with rotatable", () => {
		const parsed = TemplateManifestSchema.safeParse({
			...base,
			variables: {
				B: { value: "${password:20}", rotatable: true, initial_only: true },
			},
		});
		expect(parsed.success).toBe(false);
		expect(JSON.stringify(parsed.error?.issues)).toContain(
			"initial_only variables cannot be rotatable",
		);
	});

	it("cannot depend on a rotatable variable, directly or not", () => {
		const parse = (value: string) =>
			TemplateManifestSchema.safeParse({
				...base,
				variables: {
					SECRET: { value: "${password:32}", rotatable: true },
					DERIVED: { value: "x-${SECRET}" },
					PLAIN: { value: "${password:16}" },
					ADMIN: { value, initial_only: true },
				},
			});
		for (const value of ["${jwt:SECRET:admin}", "${DERIVED}-1"]) {
			const parsed = parse(value);
			expect(parsed.success).toBe(false);
			expect(JSON.stringify(parsed.error?.issues)).toContain(
				"initial_only variables cannot depend on a rotatable one (SECRET)",
			);
		}
		expect(parse("${PLAIN}-admin").success).toBe(true);
	});

	it("marks the PocketBase superuser (created on the first start only)", () => {
		const { variables } = shipped("pocketbase");
		expect(variables.PB_ADMIN_EMAIL.initial_only).toBe(true);
		expect(variables.PB_ADMIN_PASSWORD.initial_only).toBe(true);
		expect(variables.PB_ENCRYPTION_KEY.initial_only).toBe(false);
		// The compose really only upserts while there is no data yet.
		expect(
			readFileSync("templates/pocketbase/docker-compose.yml", "utf8"),
		).toMatch(
			/if \[ ! -f \/pb\/pb_data\/data\.db \]; then\s+\/pb\/pocketbase superuser upsert/,
		);
	});

	it("marks the Appwrite console admin password (signed up once by an import)", () => {
		const { variables } = shipped("appwrite");
		expect(variables.CONSOLE_ADMIN_PASSWORD.initial_only).toBe(true);
		// The email also feeds the sign-up whitelist on every start.
		expect(variables.CONSOLE_ADMIN_EMAIL.initial_only).toBe(false);
	});

	it("marks the Umami admin (default password replaced once)", () => {
		const { variables } = shipped("umami");
		expect(variables.ADMIN_USERNAME.initial_only).toBe(true);
		expect(variables.ADMIN_PASSWORD.initial_only).toBe(true);
	});
});
