/**
 * CI check: every locale catalog translates every message of the source
 * catalog (run after `bun run i18n:extract`). Exits 1 and lists what is
 * missing otherwise.
 *
 *   bun run i18n:check
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../../src/locales");
const read = <T>(file: string): T =>
	JSON.parse(readFileSync(path.join(dir, file), "utf8")) as T;

// src/locales/locales.json: the single locale manifest.
const locales = read<{ code: string; source?: boolean }[]>("locales.json");
const source = locales.find((locale) => locale.source)?.code ?? "en";
const ids = Object.keys(read<Record<string, unknown>>(`${source}.json`));

let failed = false;
for (const { code } of locales) {
	if (code === source) continue;
	const catalog = read<Record<string, unknown>>(`${code}.json`);
	const missing = ids.filter(
		(id) => typeof catalog[id] !== "string" || catalog[id] === "",
	);
	if (missing.length > 0) {
		failed = true;
		console.error(`${code}: ${missing.length} missing`);
		for (const id of missing.slice(0, 20)) console.error(`  - ${id}`);
	} else {
		console.info(`${code}: 0 missing (${ids.length} messages)`);
	}
}
process.exit(failed ? 1 : 0);
