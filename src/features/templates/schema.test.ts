import { describe, expect, it } from "vitest";
import {
	extraDomainRule,
	extraDomainRules,
	TemplateManifestSchema,
} from "./schema";

describe("template texts are English only", () => {
	const base = {
		id: "demo",
		name: "Demo",
		source: { repo: "a/b", versions: "tags" },
	};

	it("rejects i18n tables anywhere in the manifest", () => {
		const cases = [
			{ ...base, i18n: { xx: { name: "x" } } },
			{
				...base,
				variables: {
					SMTP_HOST: {
						value: "",
						label: "SMTP host",
						i18n: { xx: { label: "x" } },
					},
				},
			},
			{ ...base, security: { reason: "x", i18n: { xx: { reason: "y" } } } },
		];
		for (const manifest of cases) {
			const parsed = TemplateManifestSchema.safeParse(manifest);
			expect(parsed.success).toBe(false);
			expect(JSON.stringify(parsed.error?.issues)).toContain(
				"i18n tables are not supported",
			);
		}
		expect(TemplateManifestSchema.safeParse(base).success).toBe(true);
	});

	it("rejects ICU braces in translatable texts", () => {
		for (const manifest of [
			{ ...base, description: "Set {VAR} first" },
			{
				...base,
				variables: { A: { value: "", label: 'JSON {"a": 1}' } },
			},
		]) {
			const parsed = TemplateManifestSchema.safeParse(manifest);
			expect(parsed.success).toBe(false);
			expect(JSON.stringify(parsed.error?.issues)).toContain(
				"ICU placeholders are not supported",
			);
		}
	});
});

describe("manifest checks", () => {
	const base = {
		id: "demo",
		name: "Demo",
		source: { repo: "a/b", versions: "tags" },
	};

	it("requires basic_auth variables to exist and rotatable ones to be generated", () => {
		expect(() =>
			TemplateManifestSchema.parse({
				...base,
				domains: [
					{
						service: "web",
						port: 80,
						basic_auth: { username: "U", password: "P" },
					},
				],
			}),
		).toThrow(/basic_auth/);
		expect(() =>
			TemplateManifestSchema.parse({
				...base,
				variables: { X: { value: "fixed", rotatable: true } },
			}),
		).toThrow(/rotatable/);
		expect(
			TemplateManifestSchema.parse({
				...base,
				variables: { X: { value: "${password:20}", rotatable: true } },
				health: { path: "/", expect: [200, 401] },
				domains: [{ service: "web", port: 80 }],
			}).health?.expect,
		).toEqual([200, 401]);
	});

	it("validates on_rotate steps (rotatable only, plain SQL, safe roles)", () => {
		const hook = {
			label: "Sign out all users",
			description: "Every session is deleted.",
			skipped: "Sessions stay valid.",
			service: "db",
			user: "supabase_admin",
			database: "postgres",
			sql: "delete from auth.sessions;",
		};
		const parse = (variable: Record<string, unknown>) =>
			TemplateManifestSchema.safeParse({
				...base,
				variables: { JWT: { value: "${password:40}", ...variable } },
			});
		const ok = parse({ rotatable: true, on_rotate: hook });
		expect(ok.success).toBe(true);
		// Ticked unless the template says otherwise.
		expect(ok.data?.variables.JWT.on_rotate?.default).toBe(true);
		expect(
			parse({ rotatable: true, on_rotate: { ...hook, default: false } }).data
				?.variables.JWT.on_rotate?.default,
		).toBe(false);
		// Backslashes inside literals and comments are plain SQL.
		expect(
			parse({
				rotatable: true,
				on_rotate: {
					...hook,
					sql: "select E'a\\\\b'; -- c:\\\\tmp\ndelete from auth.sessions;",
				},
			}).success,
		).toBe(true);
		expect(parse({ on_rotate: hook }).error?.message).toMatch(
			/on_rotate needs rotatable/,
		);
		for (const bad of [
			{ sql: "\\! rm -rf /" },
			// A meta-command after plain SQL, not only at the start.
			{ sql: "select 1;\n\\! id" },
			{ sql: "delete from t where a = 'x" },
			{ sql: "  " },
			{ user: "Admin; drop" },
			{ database: "a b" },
			{ service: "-db" },
			{ label: "Sign out {count}" },
			{ label: "" },
		]) {
			expect(
				parse({ rotatable: true, on_rotate: { ...hook, ...bad } }).success,
			).toBe(false);
		}
	});

	it("allows min_version only for named versions", () => {
		const gated = {
			variables: { X: { value: "${password:20}", min_version: "v1.2.0" } },
			overlays: [{ path: "overlay-x.yml", min_version: "v1.2.0" }],
		};
		const include = ["compose.yml", { path: "init.sh", min_version: "v1.2.0" }];
		for (const versions of ["releases", "tags", "branches"]) {
			expect(
				TemplateManifestSchema.safeParse({
					...base,
					...gated,
					source: { repo: "a/b", versions, include, min_version: "v1.1.0" },
				}).success,
			).toBe(true);
		}
		const parsed = TemplateManifestSchema.safeParse({
			...base,
			...gated,
			source: {
				repo: "a/b",
				versions: "commits",
				include,
				min_version: "v1.1.0",
			},
		});
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([
			"variables.X.min_version",
			"overlays.0.min_version",
			"source.include.1.min_version",
			"source.min_version",
		]);
		// Custom compose has no upstream versions: no floor either.
		expect(
			TemplateManifestSchema.safeParse({
				...base,
				source: { type: "inline", min_version: "v1.1.0" },
			}).error?.issues.map((issue) => issue.path.join(".")),
		).toContain("source.min_version");
		expect(
			TemplateManifestSchema.safeParse({
				...base,
				source: { repo: "a/b", versions: "commits" },
			}).success,
		).toBe(true);
	});

	it("validates data_binds as paths inside the app folder", () => {
		const parse = (data_binds: string[]) =>
			TemplateManifestSchema.safeParse({ ...base, data_binds }).success;
		expect(parse(["data/app.json", "uploads"])).toBe(true);
		expect(parse(["/etc/passwd"])).toBe(false);
		expect(parse(["../x.json"])).toBe(false);
		expect(parse(["."])).toBe(false);
		expect(TemplateManifestSchema.parse(base).data_binds).toEqual([]);
	});

	it("rejects duplicate port ids", () => {
		const port = { id: "db", service: "db", port: 5432, label: "DB" };
		expect(() =>
			TemplateManifestSchema.parse({ ...base, ports: [port, port] }),
		).toThrow(/unique/);
	});

	it("reads additional-domain rules per routed service and port", () => {
		const domain = { service: "web", port: 3000, primary: true };
		const manifest = TemplateManifestSchema.parse({
			...base,
			domains: [
				{
					...domain,
					extra_domains: { policy: "warn", reason: "Console only." },
				},
				{ service: "api", port: 80 },
			],
		});
		const rules = extraDomainRules(manifest.domains);
		expect(rules).toEqual([
			{ service: "web", port: 3000, policy: "warn", reason: "Console only." },
		]);
		const at = (service: string, port: number, primary = false) =>
			extraDomainRule(rules, { service, port, primary });
		expect(at("web", 3000)?.policy).toBe("warn");
		expect(at("web", 3000, true)).toBeNull(); // the primary domain
		expect(at("web", 8080)).toBeNull();
		expect(at("api", 80)).toBeNull();
		for (const extra of [
			{ policy: "block", reason: "x" },
			{ policy: "warn" },
			{ policy: "warn", reason: "Use {domain}" },
		]) {
			expect(
				TemplateManifestSchema.safeParse({
					...base,
					domains: [{ ...domain, extra_domains: extra }],
				}).success,
			).toBe(false);
		}
	});
});

describe("variable permission", () => {
	const base = {
		id: "demo",
		name: "Demo",
		source: { repo: "a/b", versions: "tags" },
	};
	const withPermission = (permission: string) => ({
		...base,
		variables: { MIRROR: { value: "", editable: true, permission } },
	});

	it("accepts team permissions from the registry only", () => {
		expect(
			TemplateManifestSchema.safeParse(withPermission("app.terminal")).success,
		).toBe(true);
		expect(
			TemplateManifestSchema.safeParse(withPermission("app.everything"))
				.success,
		).toBe(false);
		// Instance permissions never come from a team role.
		expect(
			TemplateManifestSchema.safeParse(withPermission("instance.manage"))
				.success,
		).toBe(false);
	});
});
