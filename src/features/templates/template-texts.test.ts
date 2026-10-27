import { readdirSync, readFileSync } from "node:fs";
import type { ExtractedMessage } from "@lingui/conf";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { translateTemplateText } from "#/libs/i18n.ts";
import { sourceLocale } from "#/libs/locale-manifest.ts";
import { serverI18n } from "#/server/services/i18n.ts";
import { templateExtractor } from "../../../scripts/lingui/template-extractor.ts";
import { templateTexts } from "./template-texts";

const FIXTURE = `
id = "demo"
name = "Demo"
description = "A demo app."
notes = "Sign in now."
limitation = "No email."

[security]
privileged = true
reason = "Needs the Docker socket."

[variables.ADMIN_EMAIL]
value = "admin@\${domain}"
label = "Admin email"
description = "Sign-in email"
group = "Admin"

[variables.SECRET]
value = "\${password:32}"
rotatable = true

[variables.SECRET.on_rotate]
label = "Sign out all users"
description = "Sessions are deleted."
skipped = "Sessions stay valid."
service = "db"
user = "admin"
database = "app"
sql = "delete from sessions;"

[[domains]]
service = "web"
port = 3000
primary = true
extra_domains = { policy = "warn", reason = "Sign-in only works on the primary domain." }

[[ports]]
id = "db"
service = "db"
port = 5432
label = "Database"
description = "psql access"
`;

async function extract(filename: string, code: string) {
	const out: ExtractedMessage[] = [];
	if (!templateExtractor.match(filename)) return out;
	if (!("extract" in templateExtractor)) throw new Error("per-file extractor");
	await templateExtractor.extract(filename, code, (msg) => out.push(msg), {
		linguiConfig: {} as never,
	});
	return out;
}

describe("template extractor", () => {
	it("emits every translatable field with the English text as id", async () => {
		const messages = await extract(
			"/repo/templates/demo/template.toml",
			FIXTURE,
		);
		expect(messages.map((msg) => msg.id)).toEqual([
			"Demo",
			"A demo app.",
			"Sign in now.",
			"No email.",
			"Needs the Docker socket.",
			"Admin email",
			"Sign-in email",
			"Admin",
			"Sign out all users",
			"Sessions are deleted.",
			"Sessions stay valid.",
			"Sign-in only works on the primary domain.",
			"Database",
			"psql access",
		]);
		expect(messages[5].comment).toBe(
			"template demo: variable ADMIN_EMAIL label",
		);
		expect(messages[8].comment).toBe(
			"template demo: variable SECRET on_rotate label",
		);
		expect(messages[5].origin?.[1]).toBe(
			FIXTURE.split("\n").findIndex((line) => line.includes("Admin email")) + 1,
		);
	});

	it("only handles shipped template.toml files", async () => {
		expect(templateExtractor.match("/repo/templates/demo/template.toml")).toBe(
			true,
		);
		expect(templateExtractor.match("/repo/templates/demo/compose.yml")).toBe(
			false,
		);
		expect(
			templateExtractor.match(
				"/repo/src/server/services/templates/__fixtures__/templates/demo/template.toml",
			),
		).toBe(false);
	});
});

function shippedTexts() {
	const out: { id: string; field: string; text: string }[] = [];
	for (const id of readdirSync("templates")) {
		let raw: unknown;
		try {
			raw = parse(readFileSync(`templates/${id}/template.toml`, "utf8"));
		} catch {
			continue;
		}
		for (const text of templateTexts(raw)) out.push({ id, ...text });
	}
	return out;
}

describe("shipped templates", () => {
	const sourceCatalog: Record<string, string> = JSON.parse(
		readFileSync(`src/locales/${sourceLocale}.json`, "utf8"),
	);
	it("render unchanged through translateTemplateText in the source locale (no ICU syntax)", () => {
		const i18n = serverI18n(sourceLocale);
		const changed = shippedTexts()
			.filter(({ text }) => translateTemplateText(i18n, text) !== text)
			.map(({ id, field, text }) => `${id} ${field}: ${text}`);
		expect(changed).toEqual([]);
	});

	it("have every translatable text in the catalog (run i18n:extract)", () => {
		const missing: string[] = [];
		for (const id of readdirSync("templates")) {
			let raw: unknown;
			try {
				raw = parse(readFileSync(`templates/${id}/template.toml`, "utf8"));
			} catch {
				continue;
			}
			for (const { text, field } of templateTexts(raw)) {
				if (!(text in sourceCatalog)) missing.push(`${id} ${field}: ${text}`);
			}
		}
		expect(missing).toEqual([]);
	});
});
