import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { localeCodes } from "./locale-manifest.ts";

/**
 * Permanent guard for the i18n rulebook: translations and other per-locale
 * data live only in `src/locales/` (catalogs, glossaries, the manifest).
 *
 * Scanned: every file git tracks or would track (not ignored) with a code,
 * script or config extension, except `src/locales/**` and test fixture
 * folders (`__fixtures__`/`fixtures`, data for deliberate rendering checks).
 * Markdown and JSON data files are not scanned.
 *
 * Fails on
 * - a non-English letter: any non-ASCII letter, combining mark or digit
 *   (Latin with diacritics, CJK, Cyrillic, Greek, Arabic...), in the source
 *   text or in the decoded value of a string literal (so `\u` escapes do not
 *   hide one). Punctuation, symbols and spaces (`…`, `→`, `·`, `—`, `•`,
 *   box drawing, emoji, NBSP) are allowed;
 * - an object literal keyed by a locale code of the manifest
 *   (`{ vi: ... }`): per-locale maps belong in locale files.
 */
const SCANNED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|toml)$/;
const EXCLUDED = [/^src\/locales\//, /(^|\/)(__fixtures__|fixtures)\//];
const SCRIPT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** Parsing every tracked script takes well over vitest's default 5s. */
const SCAN_TIMEOUT_MS = 60_000;
/** Non-ASCII letters, marks and decimal digits. */
const FOREIGN = /[^\p{ASCII}](?<=[\p{L}\p{M}\p{Nd}])/u;

function scannedFiles(): string[] {
	return execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	)
		.split("\0")
		.filter(
			(file) =>
				SCANNED.test(file) &&
				// Deleted in the working tree but still in the index.
				existsSync(file) &&
				!EXCLUDED.some((pattern) => pattern.test(file)),
		);
}

function describeChar(text: string): string {
	const char = text.match(FOREIGN)?.[0] ?? "";
	const code = char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0");
	return `U+${code}`;
}

/** Non-English letters in raw text, one finding per line. */
function foreignTextFindings(file: string, text: string): string[] {
	return text
		.split("\n")
		.flatMap((line, index) =>
			FOREIGN.test(line)
				? [`${file}:${index + 1}: non-English letter ${describeChar(line)}`]
				: [],
		);
}

/** String literals hiding letters behind escapes, and locale-keyed objects. */
function scriptFindings(
	file: string,
	text: string,
	locales: readonly string[],
): string[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const out: string[] = [];
	const at = (node: ts.Node) =>
		`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
	const visit = (node: ts.Node) => {
		if (
			(ts.isStringLiteralLike(node) ||
				ts.isTemplateHead(node) ||
				ts.isTemplateMiddle(node) ||
				ts.isTemplateTail(node)) &&
			FOREIGN.test(node.text) &&
			!FOREIGN.test(node.getText(source))
		) {
			out.push(
				`${at(node)}: escaped non-English letter ${describeChar(node.text)}`,
			);
		}
		if (ts.isObjectLiteralExpression(node)) {
			for (const property of node.properties) {
				const name = property.name;
				if (
					name &&
					(ts.isIdentifier(name) ||
						ts.isStringLiteral(name) ||
						ts.isNoSubstitutionTemplateLiteral(name)) &&
					locales.includes(name.text)
				) {
					out.push(`${at(property)}: object keyed by locale "${name.text}"`);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return out;
}

describe("no locale data outside src/locales", () => {
	it("finds what it guards against", () => {
		const letter = String.fromCodePoint(0xe9);
		expect(foreignTextFindings("a.ts", `x\nconst a = "caf${letter}";`)).toEqual(
			["a.ts:2: non-English letter U+00E9"],
		);
		expect(foreignTextFindings("a.ts", "a … → · — • ─   🙂")).toEqual([]);
		expect(
			scriptFindings(
				"a.ts",
				'const a = { aa: "x", "bb": 1, cc: 2 };\nconst b = "\\u00e9";',
				["aa", "bb"],
			),
		).toEqual([
			'a.ts:1: object keyed by locale "aa"',
			'a.ts:1: object keyed by locale "bb"',
			"a.ts:2: escaped non-English letter U+00E9",
		]);
	});

	it(
		"tracked code, scripts and config hold no translations or locale maps",
		() => {
			const findings = scannedFiles().flatMap((file) => {
				const text = readFileSync(file, "utf8");
				return [
					...foreignTextFindings(file, text),
					...(SCRIPT.test(file) ? scriptFindings(file, text, localeCodes) : []),
				];
			});
			expect(findings).toEqual([]);
		},
		SCAN_TIMEOUT_MS,
	);
});
