import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_NAME } from "#/config/shared.ts";

/**
 * Guard for the rename to Nitrobase: the former product name appears
 * nowhere in the repository (code, comments, tests, fixtures, snapshots,
 * catalogs, migrations, docs), with no exception. Display text names the
 * product through `APP_NAME` (`{appName}` in messages), machine names
 * through `APP_ID` / `RESOURCE_PREFIX`.
 */
const ROOT = path.resolve(__dirname, "../..");

/** The former name, spelled so this file does not contain it. */
const OLD_BRAND = ["saas", "base"].join("");
const oldBrandIn = (text: string) =>
	text.match(new RegExp(`.{0,40}${OLD_BRAND}.{0,40}`, "gi")) ?? [];

/** Folders scanned recursively (the tracked content of the repository). */
const SCANNED_DIRS = [
	".agents",
	".github",
	".vscode",
	"drizzle",
	"public",
	"scripts",
	"src",
	"templates",
];
/** Dot files at the root that belong to the repository (never `.env`). */
const ROOT_DOT_FILES = [
	".cta.json",
	".dockerignore",
	".env.example",
	".gitignore",
];
const SKIPPED_DIRS = new Set(["node_modules"]);

function filesIn(dir: string): string[] {
	if (!existsSync(path.join(ROOT, dir))) return [];
	return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(
		(entry) => {
			const rel = `${dir}/${entry.name}`;
			if (entry.isDirectory()) {
				return SKIPPED_DIRS.has(entry.name) ? [] : filesIn(rel);
			}
			return entry.isFile() ? [rel] : [];
		},
	);
}

/** Every scanned file: the folders above and the files at the root. */
function scannedFiles(): string[] {
	const top = readdirSync(ROOT).filter(
		(name) =>
			(!name.startsWith(".") || ROOT_DOT_FILES.includes(name)) &&
			statSync(path.join(ROOT, name)).isFile(),
	);
	return [...SCANNED_DIRS.flatMap(filesIn), ...top];
}

describe("brand guard", () => {
	const scanned = scannedFiles();

	it("finds the old product name nowhere", () => {
		const found = scanned.flatMap((file) => {
			const content = readFileSync(path.join(ROOT, file));
			if (content.includes(0)) return []; // binary
			return oldBrandIn(content.toString("utf8")).map(
				(match) => `${file}: ${match.trim()}`,
			);
		});
		expect(found).toEqual([]);
	});

	it("scans the README, the catalogs, the installer and the tests", () => {
		for (const file of [
			"README.md",
			"src/locales/en.json",
			"scripts/install.sh",
			"docker-compose.prod.yml",
			".env.example",
			"src/config/brand.guard.test.ts",
		]) {
			expect(scanned).toContain(file);
		}
	});

	it("keeps the old brand out of the README", () => {
		const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
		expect(oldBrandIn(readme)).toEqual([]);
	});

	it("keeps the brand out of the message catalogs", () => {
		for (const catalog of readdirSync(path.join(ROOT, "src/locales"))) {
			if (!catalog.endsWith(".json")) continue;
			const text = readFileSync(
				path.join(ROOT, "src/locales", catalog),
				"utf8",
			);
			expect(oldBrandIn(text), catalog).toEqual([]);
			expect(text, catalog).not.toContain(APP_NAME);
		}
	});

	it("names the product after APP_NAME outside src", () => {
		const manifest = JSON.parse(
			readFileSync(path.join(ROOT, "public/manifest.json"), "utf8"),
		) as { name: string; short_name: string };
		expect(manifest.short_name).toBe(APP_NAME);
		expect(manifest.name.startsWith(APP_NAME)).toBe(true);
		const installer = readFileSync(
			path.join(ROOT, "scripts/install.sh"),
			"utf8",
		);
		expect(installer).toContain(`readonly PRODUCT_NAME="${APP_NAME}"`);
	});
});
