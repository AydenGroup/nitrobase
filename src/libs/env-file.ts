import { assertUserEnvName, TemplateError } from "#/libs/naming-rules.ts";

/**
 * The `.env` format Nitrobase reads and writes: pure (no Node APIs), shared
 * by the server (render, env edits) and the client (env editor drafts), so
 * both parse a pasted `.env` the same way.
 */

/** Placeholder of a secret value that was not revealed (kept on save). */
export const SECRET_MASK = "********";

/**
 * Render a compose `.env` file. Values are always quoted so nothing is
 * interpolated by a shell; single quotes when possible (literal in compose),
 * otherwise double quotes with `\\`, `"`, `$` and newlines escaped.
 */
export function renderEnvFile(values: Record<string, string>): string {
	const lines: string[] = [];
	for (const [name, value] of Object.entries(values)) {
		assertUserEnvName(name);
		if (value.includes("\0")) {
			throw new TemplateError("VARIABLE_NUL", { name });
		}
		const quoted =
			!value.includes("'") && !/[\r\n]/.test(value)
				? `'${value}'`
				: `"${value
						.replace(/\\/g, "\\\\")
						.replace(/"/g, '\\"')
						.replace(/\$/g, "\\$")
						.replace(/\r/g, "\\r")
						.replace(/\n/g, "\\n")}"`;
		lines.push(`${name}=${quoted}`);
	}
	return `${lines.join("\n")}\n`;
}

/** Minimal dotenv parser for upstream `.env.example` defaults. */
export function parseEnvFile(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(
			/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
		);
		if (!match) continue;
		let value = match[2];
		const quote = value[0];
		if (
			(quote === '"' || quote === "'") &&
			value.endsWith(quote) &&
			value.length > 1
		) {
			value = value.slice(1, -1);
			if (quote === '"')
				value = value.replace(/\\n/g, "\n").replace(/\\(["\\$])/g, "$1");
		} else {
			value = value.replace(/\s+#.*$/, "");
		}
		out[match[1]] = value;
	}
	return out;
}

const ENV_LINE = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/;

/** Reject lines that are neither comments, blank, nor KEY=value. */
export function assertEnvLines(text: string): void {
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = raw.trim();
		if (!line || line.startsWith("#")) return;
		if (!ENV_LINE.test(line)) {
			throw new TemplateError("ENV_LINE_INVALID", {
				line: index + 1,
				text: line.slice(0, 60),
			});
		}
	});
}
