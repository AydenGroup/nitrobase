/**
 * `KEY=value` text <-> record for the git wizard and settings (build
 * arguments, build secrets, runtime env). Blank lines and `#` comments are
 * skipped; one pair of surrounding quotes is removed from a value.
 */
const NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED = /^(COMPOSE_|DOCKER_|BUILDKIT_)/;

export function parseEnvText(text: string): {
	values: Record<string, string>;
	/** Offending names (invalid or reserved), for an inline error. */
	invalid: string[];
} {
	const values: Record<string, string> = {};
	const invalid: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const index = line.indexOf("=");
		const name = (index === -1 ? line : line.slice(0, index)).trim();
		let value = index === -1 ? "" : line.slice(index + 1);
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		if (!NAME.test(name) || RESERVED.test(name)) invalid.push(name);
		else values[name] = value;
	}
	return { values, invalid };
}

export function envText(values: Record<string, string>): string {
	return Object.entries(values)
		.map(([name, value]) => `${name}=${value}`)
		.join("\n");
}
