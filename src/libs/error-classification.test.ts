import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Error and log classification (permanent guard).
 *
 * Panel text a user can see is coded, never English built on the server:
 * - errors a user can trigger or see are `AppError(code, params)` (or a
 *   `TemplateError`, its subclass): rendered from `#/libs/error-codes.ts`;
 * - internal invariants (programming errors, impossible states) use
 *   `internalError(message)`: English for operators, never shown as is;
 * - raw third-party output (stderr, an HTTP body) uses
 *   `toolOutputError(output)`: shown as is, behind "Details";
 * - job log lines the panel writes are events (`ctx.event(code, params)`,
 *   `#/config/job-log-events.ts`); `ctx.log(output)` only takes raw output,
 *   never a literal text.
 *
 * So, in server and shared code (`src/features`, `src/server`, `src/libs`,
 * `src/utils`, `src/config`, `src/db`, `src/routes/api`):
 * - `new Error(...)` is not used (only the helpers above create plain
 *   errors, in `src/utils/plain-errors.ts`);
 * - `<x>.log(...)` (not `console.log`) never gets a string or template
 *   literal with letters;
 * - stored error columns (`lastError`, `errorMessage`, `error`) are never
 *   set to a literal text.
 */
const SCOPE = [
	/^src\/features\//,
	/^src\/server\//,
	/^src\/libs\//,
	/^src\/utils\//,
	/^src\/config\//,
	/^src\/db\//,
	/^src\/routes\/api\//,
];
const EXCLUDED = [/\.test\.tsx?$/, /(^|\/)__fixtures__\//];
/** Files allowed to create plain errors (see the rules above). */
const PLAIN_ERROR_FILES = new Set([
	"src/utils/plain-errors.ts",
	// Re-throws an AppError as its localized message for the client.
	"src/libs/errorMiddleware.ts",
]);
/** Calls allowed to log a literal (none today; keep the list explicit). */
const LITERAL_LOG_ALLOWLIST = new Set<string>();
const ERROR_COLUMNS = new Set(["lastError", "errorMessage", "checkError"]);

function scopedFiles(): string[] {
	return execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	)
		.split("\0")
		.filter(
			(file) =>
				/\.tsx?$/.test(file) &&
				existsSync(file) &&
				SCOPE.some((pattern) => pattern.test(file)) &&
				!EXCLUDED.some((pattern) => pattern.test(file)),
		);
}

const hasLetters = (node: ts.Node): boolean => {
	if (ts.isStringLiteralLike(node)) return /[A-Za-z]/.test(node.text);
	if (ts.isTemplateExpression(node)) {
		return [node.head, ...node.templateSpans.map((span) => span.literal)].some(
			(part) => /[A-Za-z]/.test(part.text),
		);
	}
	return false;
};

/** Violations of the rules above in one source file. */
function findings(file: string, text: string): string[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const out: string[] = [];
	const at = (node: ts.Node) =>
		`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
	const visit = (node: ts.Node) => {
		if (
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "Error" &&
			!PLAIN_ERROR_FILES.has(file)
		) {
			out.push(
				`${at(node)}: new Error(...): use AppError, internalError or toolOutputError`,
			);
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "log" &&
			!(
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === "console"
			) &&
			node.arguments[0] &&
			hasLetters(node.arguments[0]) &&
			!LITERAL_LOG_ALLOWLIST.has(at(node))
		) {
			out.push(
				`${at(node)}: literal job log text: use ctx.event(code, params)`,
			);
		}
		if (
			ts.isPropertyAssignment(node) &&
			ts.isIdentifier(node.name) &&
			ERROR_COLUMNS.has(node.name.text) &&
			hasLetters(node.initializer)
		) {
			out.push(`${at(node)}: literal ${node.name.text}: store a coded error`);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return out;
}

describe("error and log classification", () => {
	it("finds what it guards against", () => {
		const sample = [
			'throw new Error("App not found");',
			'ctx.log("Deploying...");',
			"ctx.log(`Uploading ${size} MB`);",
			"ctx.log(chunk);",
			'console.log("fine");',
			'const row = { lastError: "Interrupted" };',
			"const ok = { lastError: null };",
		].join("\n");
		expect(findings("src/features/x.server.ts", sample)).toEqual([
			"src/features/x.server.ts:1: new Error(...): use AppError, internalError or toolOutputError",
			"src/features/x.server.ts:2: literal job log text: use ctx.event(code, params)",
			"src/features/x.server.ts:3: literal job log text: use ctx.event(code, params)",
			"src/features/x.server.ts:6: literal lastError: store a coded error",
		]);
	});

	it("server and shared code follows the rules", () => {
		const out = scopedFiles().flatMap((file) =>
			findings(file, readFileSync(file, "utf8")),
		);
		expect(out).toEqual([]);
	}, 60_000);
});
