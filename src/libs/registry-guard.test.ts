import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { DATABASE_ENGINE_IDS } = await import("#/config/database-engines.ts");
const { destinationDrivers } = await import("#/config/backup-drivers.ts");

/**
 * Registry guard (permanent): adding a database engine or a backup
 * destination is one registered module, so code outside the registries
 * never branches on their ids:
 * - no `engine === "<engine id>"` / `switch (x.engine) { case "…" }`
 *   (use the engine driver, #/server/services/databases/engines.ts, or
 *   the client registry's flags);
 * - no `destination.type === "<driver type>"` (use the driver's
 *   declared `capabilities`).
 */
const SCOPE = [
	/^src\/features\//,
	/^src\/components\//,
	/^src\/routes\//,
	/^src\/server\//,
	/^src\/libs\//,
];
const EXCLUDED = [
	/\.test\.tsx?$/,
	/(^|\/)__fixtures__\//,
	// The registries themselves.
	/^src\/server\/services\/databases\/engines(\.ts|\/)/,
];
const ENGINE_IDS = new Set<string>(DATABASE_ENGINE_IDS);
const DESTINATION_TYPES = new Set(destinationDrivers.map((d) => d.type));
const ENGINE_EXPR = /(^|\.)engine$/;
const DESTINATION_EXPR = /(^|\.)destination\.type$/;

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

function findings(file: string, text: string): string[] {
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const out: string[] = [];
	const at = (node: ts.Node) =>
		`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
	const literal = (node: ts.Node) =>
		ts.isStringLiteralLike(node) ? node.text : null;
	const check = (node: ts.Node, value: string, other: ts.Node) => {
		const expr = other.getText(source);
		if (ENGINE_IDS.has(value) && ENGINE_EXPR.test(expr)) {
			out.push(`${at(node)}: branches on engine "${value}": use the driver`);
		}
		if (DESTINATION_TYPES.has(value) && DESTINATION_EXPR.test(expr)) {
			out.push(
				`${at(node)}: branches on destination "${value}": use its capabilities`,
			);
		}
	};
	const visit = (node: ts.Node) => {
		if (
			ts.isBinaryExpression(node) &&
			[
				ts.SyntaxKind.EqualsEqualsEqualsToken,
				ts.SyntaxKind.ExclamationEqualsEqualsToken,
			].includes(node.operatorToken.kind)
		) {
			const left = literal(node.left);
			const right = literal(node.right);
			if (left !== null) check(node, left, node.right);
			if (right !== null) check(node, right, node.left);
		}
		if (ts.isSwitchStatement(node)) {
			for (const clause of node.caseBlock.clauses) {
				if (!ts.isCaseClause(clause)) continue;
				const value = literal(clause.expression);
				if (value !== null) check(clause, value, node.expression);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return out;
}

describe("registry guard", () => {
	it("finds what it guards against", () => {
		const sample = [
			'if (ctx.engine === "postgres") {}',
			'switch (engine) { case "valkey": break; }',
			'if (destination.type === "local") {}',
			'if (dialect === "postgres") {}',
			'if (row.status === "running") {}',
		].join("\n");
		expect(findings("src/features/x.server.ts", sample)).toEqual([
			'src/features/x.server.ts:1: branches on engine "postgres": use the driver',
			'src/features/x.server.ts:2: branches on engine "valkey": use the driver',
			'src/features/x.server.ts:3: branches on destination "local": use its capabilities',
		]);
	});

	it("code outside the registries never branches on their ids", () => {
		const out = scopedFiles().flatMap((file) =>
			findings(file, readFileSync(file, "utf8")),
		);
		expect(out).toEqual([]);
	}, 60_000);
});
